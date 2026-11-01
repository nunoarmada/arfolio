import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@arfolio/db';
import type { AnthropicCreateLike, AssetEstimateResult, DueAsset } from '@arfolio/services';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';

const services = vi.hoisted(() => ({
  claimDueAssetValuations: vi.fn(),
  estimateAssetValue: vi.fn(),
  markAssetValuationFailed: vi.fn(),
}));
vi.mock('@arfolio/services', async (importActual) => ({
  ...(await importActual<typeof import('@arfolio/services')>()),
  ...services,
}));
vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorMessage: () => 'error',
}));

import {
  ASSET_VALUATION_BATCH,
  ASSET_VALUATION_CRON,
  ASSET_VALUATION_EXPIRE_SECONDS,
  ASSET_VALUATION_REQUEST_TIMEOUT_MS,
  registerAssetValuation,
  runAssetValuationSweep,
} from './asset-valuation.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const DEFAULT_PORTALS = makeConfig().valuationPortals.value!;
const db = {} as Db;
const anthropic: AnthropicCreateLike = { messages: { create: vi.fn() } };
const due = (assetId: string): DueAsset => ({
  householdId: 'hh',
  assetId,
  kind: 'property',
  currency: 'EUR',
  details: null,
  claimedAt: NOW,
  history: [],
});

describe('asset-valuation job', () => {
  beforeEach(() => {
    services.claimDueAssetValuations.mockReset();
    services.estimateAssetValue.mockReset();
    services.markAssetValuationFailed.mockReset();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  it('claims a batch and counts the result of each estimate', async () => {
    services.claimDueAssetValuations.mockResolvedValue([due('a'), due('b'), due('c')]);
    const results: AssetEstimateResult[] = ['ready', 'api_error', 'ready'];
    services.estimateAssetValue.mockImplementation(async () => results.shift());
    const counts = await runAssetValuationSweep(
      { db, anthropic, model: 'm', portals: DEFAULT_PORTALS },
      'UTC',
      NOW,
    );
    expect(counts).toEqual({ ready: 2, insufficient_data: 0, no_answer: 0, api_error: 1 });
    expect(services.claimDueAssetValuations).toHaveBeenCalledWith(db, {
      now: NOW,
      limit: ASSET_VALUATION_BATCH,
      tz: 'UTC',
      logger: log,
    });
    expect(services.estimateAssetValue).toHaveBeenCalledTimes(3);
    expect(services.estimateAssetValue.mock.calls[0]![0]).toMatchObject({
      db,
      anthropic,
      model: 'm',
      logger: log,
      now: NOW,
      tz: 'UTC',
    });
  });

  it('counts an estimate that throws as api_error, marks it and goes on', async () => {
    services.claimDueAssetValuations.mockResolvedValue([due('a'), due('b')]);
    services.estimateAssetValue
      .mockRejectedValueOnce(new TypeError('secret asset text'))
      .mockResolvedValueOnce('ready');
    services.markAssetValuationFailed.mockResolvedValue(undefined);
    const counts = await runAssetValuationSweep(
      { db, anthropic, model: 'm', portals: DEFAULT_PORTALS },
      'UTC',
      NOW,
    );
    expect(counts).toEqual({ ready: 1, insufficient_data: 0, no_answer: 0, api_error: 1 });
    expect(services.estimateAssetValue).toHaveBeenCalledTimes(2);
    expect(services.markAssetValuationFailed).toHaveBeenCalledWith(db, due('a'), 'api_error');
    const warned = vi
      .mocked(log.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warned).toMatch(/TypeError/);
    expect(warned).not.toMatch(/secret asset text/);
  });

  it('goes on when marking a thrown estimate fails too', async () => {
    services.claimDueAssetValuations.mockResolvedValue([due('a'), due('b')]);
    services.estimateAssetValue
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ready');
    services.markAssetValuationFailed.mockRejectedValue(new Error('db down'));
    const counts = await runAssetValuationSweep(
      { db, anthropic, model: 'm', portals: DEFAULT_PORTALS },
      'UTC',
      NOW,
    );
    expect(counts).toEqual({ ready: 1, insufficient_data: 0, no_answer: 0, api_error: 1 });
  });

  it('logs nothing when no asset is due', async () => {
    services.claimDueAssetValuations.mockResolvedValue([]);
    await runAssetValuationSweep(
      { db, anthropic, model: 'm', portals: DEFAULT_PORTALS },
      'UTC',
      NOW,
    );
    expect(services.estimateAssetValue).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('registers the queue, the job and the 15 minute schedule', async () => {
    const calls: string[] = [];
    let cron = '';
    let options: unknown;
    let queueOptions: unknown;
    const boss = {
      createQueue: async (n: string, o: unknown) => {
        calls.push(`createQueue:${n}`);
        queueOptions = o;
      },
      work: async (n: string) => void calls.push(`work:${n}`),
      schedule: async (n: string, c: string, _d: unknown, o: unknown) => {
        calls.push(`schedule:${n}`);
        cron = c;
        options = o;
      },
    } as unknown as PgBoss;
    await registerAssetValuation(
      boss,
      {
        db,
        getConfig: async () => makeConfig({ anthropicApiKey: 'k' }),
        getAnthropic: () => anthropic,
      },
      'Europe/Lisbon',
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.assetValuation}`,
        `work:${QUEUES.assetValuation}`,
        `schedule:${QUEUES.assetValuation}`,
      ]),
    );
    expect(QUEUES.assetValuation).toBe('asset-valuation');
    expect(cron).toBe(ASSET_VALUATION_CRON);
    expect(ASSET_VALUATION_CRON).toBe('*/15 * * * *');
    expect(ASSET_VALUATION_BATCH).toBe(3);
    expect(options).toEqual({ tz: 'Europe/Lisbon' });
    // a run of three estimates of up to 10 minutes each must not expire while it works
    expect(queueOptions).toMatchObject({ expireInSeconds: ASSET_VALUATION_EXPIRE_SECONDS });
    expect(ASSET_VALUATION_EXPIRE_SECONDS).toBeGreaterThanOrEqual(
      (ASSET_VALUATION_BATCH * ASSET_VALUATION_REQUEST_TIMEOUT_MS) / 1000,
    );
    expect(ASSET_VALUATION_REQUEST_TIMEOUT_MS).toBe(600_000);
  });

  const fakeBoss = () => {
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const boss = {
      createQueue: async () => {},
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) =>
        void handlers.set(n, h),
      schedule: async () => {},
    } as unknown as PgBoss;
    return { boss, handlers };
  };

  it('without an API key it registers, logs once while off and claims nothing', async () => {
    const { boss, handlers } = fakeBoss();
    await registerAssetValuation(
      boss,
      { db, getConfig: async () => makeConfig(), getAnthropic: () => null },
      'UTC',
    );
    const run = handlers.get(QUEUES.assetValuation)!;
    await run([{}]);
    await run([{}]);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(services.claimDueAssetValuations).not.toHaveBeenCalled();
  });

  it('estimates with the model and portals of the config of that run', async () => {
    const { boss, handlers } = fakeBoss();
    let cfg = makeConfig();
    await registerAssetValuation(
      boss,
      {
        db,
        getConfig: async () => cfg,
        getAnthropic: (c) => (c.anthropicApiKey.value ? anthropic : null),
      },
      'UTC',
    );
    const run = handlers.get(QUEUES.assetValuation)!;
    services.claimDueAssetValuations.mockResolvedValue([due('a1')]);
    services.estimateAssetValue.mockResolvedValue('ready');
    await run([{}]);
    expect(services.estimateAssetValue).not.toHaveBeenCalled();
    const portals = {
      property: ['example.org'],
      vehicle: ['v.example.org'],
      classifieds: ['c.example.org'],
    };
    cfg = makeConfig({ anthropicApiKey: 'sk-new', valuationModel: 'val-v2', portals });
    await run([{}]);
    expect(services.estimateAssetValue.mock.calls[0]![0]).toMatchObject({
      model: 'val-v2',
      portals,
    });
  });

  it('an unreadable stored key skips the sweep without throwing', async () => {
    const { boss, handlers } = fakeBoss();
    await registerAssetValuation(
      boss,
      { db, getConfig: async () => makeConfig({ unreadableKey: true }), getAnthropic: () => null },
      'UTC',
    );
    await expect(handlers.get(QUEUES.assetValuation)!([{}])).resolves.toBeUndefined();
    expect(services.claimDueAssetValuations).not.toHaveBeenCalled();
  });
});
