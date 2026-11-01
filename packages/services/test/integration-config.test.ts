import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEncryptionKey } from '@arfolio/core/server';
import {
  createIntegrationConfigCache,
  isAiAvailable,
  isBankingConfigured,
  resolveIntegrationConfig,
  writeInstanceSetting,
  type IntegrationConfig,
  type InstanceSettingKey,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const ENC_KEY = loadEncryptionKey('ab'.repeat(32));
const OTHER_KEY = loadEncryptionKey('cd'.repeat(32));

describe('integration config resolver', () => {
  let t: ServicesTestDb;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.owner.execute('delete from instance_secret');
  });

  const put = (name: InstanceSettingKey, value: string, key = ENC_KEY) =>
    writeInstanceSetting(t.db, key, name, value, 'user-1');
  const resolve = (env: Record<string, string | undefined> = {}) =>
    resolveIntegrationConfig(t.db, ENC_KEY, env);

  it('env beats db', async () => {
    await put('anthropic.apiKey', 'db-key');
    const cfg = await resolve({ ANTHROPIC_API_KEY: 'env-key' });
    expect(cfg.anthropicApiKey).toMatchObject({ value: 'env-key', source: 'env' });
    expect(isAiAvailable(cfg)).toBe(true);
  });

  it('an empty env variable does not count as env', async () => {
    await put('anthropic.apiKey', 'db-key');
    const cfg = await resolve({ ANTHROPIC_API_KEY: '' });
    expect(cfg.anthropicApiKey).toMatchObject({ value: 'db-key', source: 'db' });
    expect(cfg.anthropicApiKey.updatedAt).toBeInstanceOf(Date);
  });

  it('db beats default, default beats nothing, unset when no default', async () => {
    await put('ai.reportModel', 'claude-x');
    const cfg = await resolve();
    expect(cfg.models.report).toMatchObject({ value: 'claude-x', source: 'db' });
    expect(cfg.models.categorisation).toMatchObject({
      value: 'claude-haiku-5-5',
      source: 'default',
    });
    expect(cfg.models.valuation).toMatchObject({ value: 'claude-opus-5-5', source: 'default' });
    expect(cfg.enableBanking.apiUrl).toMatchObject({
      value: 'https://api.enablebanking.com',
      source: 'default',
    });
    expect(cfg.anthropicApiKey).toMatchObject({
      value: undefined,
      source: 'unset',
      unreadable: false,
      invalid: false,
    });
    expect(isAiAvailable(cfg)).toBe(false);
    expect(isBankingConfigured(cfg)).toBe(false);
  });

  it('an unreadable db value is unset', async () => {
    await put('anthropic.apiKey', 'sk-secret', OTHER_KEY);
    const cfg = await resolve();
    expect(cfg.anthropicApiKey).toMatchObject({
      value: undefined,
      source: 'unset',
      unreadable: true,
    });
    expect(isAiAvailable(cfg)).toBe(false);
  });

  it('an unreadable db value for a defaulted setting falls to the default', async () => {
    await put('ai.reportModel', 'claude-x', OTHER_KEY);
    const cfg = await resolve();
    expect(cfg.models.report).toMatchObject({
      value: 'claude-opus-5-5',
      source: 'default',
      unreadable: true,
    });
  });

  it('an invalid db value is unset and falls to the default', async () => {
    await put('enableBanking.apiUrl', 'http://example.com');
    const cfg = await resolve();
    expect(cfg.enableBanking.apiUrl).toMatchObject({
      value: 'https://api.enablebanking.com',
      source: 'default',
      invalid: true,
    });
  });

  it('normalises literal \\n sequences in a db PEM', async () => {
    await put('enableBanking.appId', 'app-1');
    await put('enableBanking.privateKey', '-----BEGIN-----\\nabc\\n-----END-----');
    const cfg = await resolve();
    expect(cfg.enableBanking.privateKey.value).toBe('-----BEGIN-----\nabc\n-----END-----');
    expect(cfg.enableBanking.privateKey.source).toBe('db');
    expect(isBankingConfigured(cfg)).toBe(true);
  });

  it('ignores unknown stored setting names', async () => {
    await t.owner.execute(
      "insert into instance_secret (name, value) values ('setting:bogus', 'x')",
    );
    const cfg = await resolve();
    expect(cfg.smtpUrl.source).toBe('unset');
  });

  it('smtp and mail settings resolve from env then db', async () => {
    await put('mail.from', 'Arfolio <a@example.com>');
    const cfg = await resolve({ SMTP_URL: 'smtp://env.example.com' });
    expect(cfg.smtpUrl).toMatchObject({ value: 'smtp://env.example.com', source: 'env' });
    expect(cfg.mailFrom).toMatchObject({ value: 'Arfolio <a@example.com>', source: 'db' });
  });

  it('treats an smtp URL with a query string or another protocol as invalid, in env and in the db', async () => {
    const bad = 'smtp://h.example.com?sendmail=true&path=/bin/sh';
    await put('smtp.url', bad);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cfg = await resolve({ SMTP_URL: 'sendmail://h' });
      expect(cfg.smtpUrl).toMatchObject({ value: undefined, source: 'unset', invalid: true });
      expect(JSON.stringify(log.mock.calls)).not.toContain('sendmail://h');
    } finally {
      log.mockRestore();
    }
  });

  it('valuation portals default', async () => {
    const cfg = await resolve();
    expect(cfg.valuationPortals.source).toBe('default');
    expect(cfg.valuationPortals.value).toEqual({
      property: ['idealista.pt', 'imovirtual.com', 'casa.sapo.pt', 'supercasa.pt'],
      vehicle: ['standvirtual.com', 'olx.pt', 'autoscout24.pt', 'custojusto.pt'],
      classifieds: ['olx.pt', 'custojusto.pt'],
    });
  });

  it('valuation portals read from db as JSON', async () => {
    const portals = { property: ['a.pt'], vehicle: ['b.pt'], classifieds: ['c.pt'] };
    await put('ai.valuationPortals', JSON.stringify(portals));
    const cfg = await resolve();
    expect(cfg.valuationPortals).toMatchObject({ value: portals, source: 'db' });
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['bad hostname', JSON.stringify({ property: ['Not A Host'], vehicle: [], classifieds: [] })],
    [
      'more than 20 entries',
      JSON.stringify({
        property: Array.from({ length: 21 }, (_, i) => `h${i}.pt`),
        vehicle: [],
        classifieds: [],
      }),
    ],
    ['missing list', JSON.stringify({ property: ['a.pt'], vehicle: [] })],
  ])('valuation portals: %s is invalid and falls to the default', async (_n, raw) => {
    await put('ai.valuationPortals', raw);
    const cfg = await resolve();
    expect(cfg.valuationPortals).toMatchObject({ source: 'default', invalid: true });
    expect(cfg.valuationPortals.value?.classifieds).toEqual(['olx.pt', 'custojusto.pt']);
  });
});

describe('integration config cache', () => {
  const cfg = { marker: 1 } as unknown as IntegrationConfig;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads once within the ttl, again after invalidate and after the ttl', async () => {
    const load = vi.fn(async () => cfg);
    const cache = createIntegrationConfigCache(load, 1000);
    await cache.get();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    cache.invalidate();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1001);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const load = vi.fn(async () => cfg);
    const cache = createIntegrationConfigCache(load, 1000);
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected load', async () => {
    const load = vi
      .fn<() => Promise<IntegrationConfig>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(cfg);
    const cache = createIntegrationConfigCache(load, 1000);
    await expect(cache.get()).rejects.toThrow('db down');
    await expect(cache.get()).resolves.toBe(cfg);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate during a load discards that load result', async () => {
    let release!: () => void;
    const load = vi
      .fn<() => Promise<IntegrationConfig>>()
      .mockImplementationOnce(() => new Promise((r) => (release = () => r(cfg))))
      .mockResolvedValue(cfg);
    const cache = createIntegrationConfigCache(load, 1000);
    const first = cache.get();
    cache.invalidate();
    release();
    await first;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
