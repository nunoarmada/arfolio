import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { createDb, schema, type Db } from '@arfolio/db';
import type { AnthropicLike } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';
import { AI_SWEEP_CRON } from './ai-categorise.js';
import {
  enqueueMerchantEnrich,
  enqueueMerchantSweep,
  MERCHANT_SWEEP_CRON,
  registerMerchantEnrich,
  runMerchantEnrichJob,
} from './merchant-enrich.js';

vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('merchant-enrich jobs', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  const ends: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    const own = createDb(testDb.ownerUrl, { max: 2 });
    db = app.db;
    owner = own.db;
    ends.push(
      () => app.pool.end(),
      () => own.pool.end(),
    );
  });
  afterAll(async () => {
    for (const end of ends) await end();
    await testDb?.drop();
  });

  async function household(aiEnabled: boolean): Promise<string> {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId: id, aiEnabled });
    return id;
  }

  it('names the merchants of the household in the payload', async () => {
    const householdId = await household(true);
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId, name: 'A', type: 'checking', currency: 'EUR' })
      .returning();
    const [row] = await owner
      .insert(schema.transaction)
      .values({
        householdId,
        accountId: account!.id,
        dedupeHash: 'h',
        bookingDate: '2026-10-05',
        amount: -500,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'COMPRA PINGO DOCE',
        source: 'connector',
      })
      .returning();
    const anthropic: AnthropicLike = {
      messages: {
        parse: async () => ({
          parsed_output: {
            items: [
              {
                id: 'm1',
                merchant: 'Pingo Doce',
                domain: null,
                city: null,
                country: null,
                isPerson: false,
              },
            ],
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    };
    await runMerchantEnrichJob({ db, anthropic, model: 'm', logos: true }, { householdId });
    const [stored] = await owner
      .select()
      .from(schema.transaction)
      .where(eq(schema.transaction.id, row!.id));
    expect(stored!.merchantId).not.toBeNull();
    expect(stored!.merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('fetches logos after the merchant pass unless they are switched off', async () => {
    const householdId = await household(true);
    await owner
      .insert(schema.merchant)
      .values({ householdId, key: 'K', displayName: 'K', domain: 'k.example' });
    const fetchSpy = vi.fn(async () => new Response('no', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await runMerchantEnrichJob(
        { db, anthropic: null, model: 'm', logos: false },
        { householdId },
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      await runMerchantEnrichJob({ db, anthropic: null, model: 'm', logos: true }, { householdId });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a malformed payload', async () => {
    await expect(
      runMerchantEnrichJob({ db, anthropic: null, model: 'm', logos: true }, { householdId: '' }),
    ).rejects.toThrow(/Invalid merchant-enrich job/);
  });

  it('queues a singleton job per household without retries', async () => {
    const sent: unknown[][] = [];
    await enqueueMerchantEnrich(async (...args) => void sent.push(args), 'hh_1');
    expect(sent).toEqual([
      [QUEUES.merchantEnrich, { householdId: 'hh_1' }, { singletonKey: 'hh_1', retryLimit: 0 }],
    ]);
  });

  it('sweeps only households with AI enabled', async () => {
    const on = await household(true);
    const off = await household(false);
    const sent: Array<{ name: string; data: { householdId: string } }> = [];
    await enqueueMerchantSweep(db, async (name, data) => {
      sent.push({ name, data: data as { householdId: string } });
    });
    const ids = sent.map((s) => s.data.householdId);
    expect(ids).toContain(on);
    expect(ids).not.toContain(off);
    expect(sent.every((s) => s.name === QUEUES.merchantEnrich)).toBe(true);
  });

  it('sweeps hourly at a different minute than the categorisation sweep', () => {
    expect(MERCHANT_SWEEP_CRON).toBe('37 * * * *');
    expect(MERCHANT_SWEEP_CRON).not.toBe(AI_SWEEP_CRON);
  });

  describe('registerMerchantEnrich', () => {
    const fakeBoss = () => {
      const calls: string[] = [];
      const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
      const boss = {
        createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
        work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => {
          calls.push(`work:${n}`);
          handlers.set(n, h);
        },
        schedule: async (n: string, cron: string) => void calls.push(`schedule:${n}:${cron}`),
        unschedule: async (n: string) => void calls.push(`unschedule:${n}`),
        send: async (n: string) => void calls.push(`send:${n}`),
      } as unknown as PgBoss;
      return { boss, calls, handlers };
    };
    const anthropic: AnthropicLike = {
      messages: {
        parse: async () => ({ parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } }),
      },
    };

    it('registers the job and schedules the sweep when a key is configured', async () => {
      const { boss, calls } = fakeBoss();
      const enqueue = await registerMerchantEnrich(
        boss,
        {
          db,
          getConfig: async () => makeConfig({ anthropicApiKey: 'k' }),
          getAnthropic: () => anthropic,
          logos: true,
        },
        'UTC',
      );
      expect(calls).toContain(`createQueue:${QUEUES.merchantEnrich}`);
      expect(calls).toContain(`work:${QUEUES.merchantEnrich}`);
      expect(calls).toContain(`work:${QUEUES.merchantSweep}`);
      expect(calls).toContain(`schedule:${QUEUES.merchantSweep}:${MERCHANT_SWEEP_CRON}`);
      await enqueue('hh_1');
      expect(calls).toContain(`send:${QUEUES.merchantEnrich}`);
    });

    it('without a key it still registers, enqueues nothing and runs do nothing', async () => {
      const { boss, calls, handlers } = fakeBoss();
      const enqueue = await registerMerchantEnrich(
        boss,
        { db, getConfig: async () => makeConfig(), getAnthropic: () => null, logos: true },
        'UTC',
      );
      expect(calls).toContain(`schedule:${QUEUES.merchantSweep}:${MERCHANT_SWEEP_CRON}`);
      expect(calls).not.toContain(`unschedule:${QUEUES.merchantSweep}`);
      await enqueue('hh_1');
      await handlers.get(QUEUES.merchantSweep)!([{}]);
      await handlers.get(QUEUES.merchantEnrich)!([{ data: { householdId: 'hh_1' } }]);
      expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    });

    it('starts working once a key appears, without a restart', async () => {
      const { boss, calls, handlers } = fakeBoss();
      let cfg = makeConfig();
      const enqueue = await registerMerchantEnrich(
        boss,
        {
          db,
          getConfig: async () => cfg,
          getAnthropic: (c) => (c.anthropicApiKey.value ? anthropic : null),
          logos: false,
        },
        'UTC',
      );
      await enqueue('hh_1');
      expect(calls.filter((c) => c.startsWith('send:'))).toEqual([]);
      cfg = makeConfig({ anthropicApiKey: 'sk-new' });
      await enqueue('hh_1');
      expect(calls).toContain(`send:${QUEUES.merchantEnrich}`);
      // the queued job now runs against the current config (no household: nothing to do, no throw)
      await expect(
        handlers.get(QUEUES.merchantEnrich)!([{ data: { householdId: await household(true) } }]),
      ).resolves.toBeUndefined();
    });
  });
});
