import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConfigFixture } from '../test-utils';

const resolve = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
const pool = vi.hoisted(() => ({ marker: 'pool' }));
vi.mock('@arfolio/services', async (orig) => ({
  ...(await orig<typeof import('@arfolio/services')>()),
  resolveIntegrationConfig: resolve,
  listenForSettingsChanges: listen,
}));
vi.mock('../lib/db', () => ({ getDb: () => ({ $client: pool }) }));

async function fresh() {
  vi.resetModules();
  return import('./integration-config');
}

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('BETTER_AUTH_URL', 'https://pfm.example.test');
  vi.stubEnv('APP_URL', 'https://pfm.example.test');
  vi.stubEnv('SETUP_TOKEN', 'y'.repeat(24));
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  resolve.mockReset();
  listen.mockReset();
  listen.mockReturnValue({ close: async () => {} });
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('arfolio.settingsListener')];
  resolve.mockImplementation(async () => integrationConfigFixture());
});
afterEach(() => vi.unstubAllEnvs());

describe('getIntegrationConfig', () => {
  it('resolves once for repeated reads and again after an invalidation', async () => {
    const m = await fresh();
    await m.getIntegrationConfig();
    await m.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(1);
    m.invalidateIntegrationConfig();
    await m.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('hands the raw process environment to the resolver', async () => {
    const m = await fresh();
    await m.getIntegrationConfig();
    expect(resolve.mock.calls[0]?.[2]).toBe(process.env);
  });

  it('starts one settings listener per process, on the first read, that drops the cache', async () => {
    const m = await fresh();
    expect(listen).not.toHaveBeenCalled();
    await m.getIntegrationConfig();
    await m.getIntegrationConfig();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(pool);

    // A change announced by another process makes the next read resolve again.
    const onChange = listen.mock.calls[0]?.[1] as () => void;
    onChange();
    await m.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps one listener when the module is re-evaluated (dev reload) and closes the old one', async () => {
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    listen.mockReturnValueOnce({ close: closes[0] }).mockReturnValueOnce({ close: closes[1] });

    const first = await fresh();
    await first.getIntegrationConfig();
    const second = await fresh();
    await second.getIntegrationConfig();
    await second.getIntegrationConfig();

    expect(listen).toHaveBeenCalledTimes(2);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();

    // The surviving listener drops the cache of the current module instance.
    const onChange = listen.mock.calls[1]?.[1] as () => void;
    await second.getIntegrationConfig();
    const before = resolve.mock.calls.length;
    onChange();
    await second.getIntegrationConfig();
    expect(resolve.mock.calls.length).toBe(before + 1);
  });
});
