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

/** A second copy of the module, as Next bundles it for server actions and for pages. */
async function secondCopy() {
  vi.resetModules();
  return import('./integration-config');
}

/** A new process: no module copy and no cache left over from an earlier test. */
async function fresh() {
  delete (globalThis as { __arfolioIntegrationConfigCache?: unknown })
    .__arfolioIntegrationConfigCache;
  return secondCopy();
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
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('arfolio.integrationConfig')];
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

  it('is invalidated for every copy of the module in the process', async () => {
    const pages = await fresh();
    await pages.getIntegrationConfig();
    const actions = await secondCopy();
    actions.invalidateIntegrationConfig();
    await pages.getIntegrationConfig();
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

  it('shares one cache and one listener between two module instances alive at once', async () => {
    // `next start` bundles this module twice (page layer and server-action layer).
    const pages = await fresh();
    const actions = await fresh();
    await pages.getIntegrationConfig();
    await actions.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);

    // A save in a server action is seen by the page layer, and the other way round.
    actions.invalidateIntegrationConfig();
    await pages.getIntegrationConfig();
    await actions.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(2);
    pages.invalidateIntegrationConfig();
    await actions.getIntegrationConfig();
    await pages.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(3);

    // A notification from another process drops the one shared cache.
    const onChange = listen.mock.calls[0]?.[1] as () => void;
    onChange();
    await pages.getIntegrationConfig();
    await actions.getIntegrationConfig();
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('reuses the cache and the listener when the module is re-evaluated (dev reload)', async () => {
    const close = vi.fn(async () => {});
    listen.mockReturnValue({ close });
    const first = await fresh();
    await first.getIntegrationConfig();
    const second = await fresh();
    second.invalidateIntegrationConfig();
    await second.getIntegrationConfig();

    expect(listen).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('does not count a listener that failed to start, and tries again on the next read', async () => {
    listen.mockImplementationOnce(() => {
      throw new Error('no connection');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await fresh();
    // Reads keep working (the TTL is the backstop); the failure is logged, message only.
    await expect(m.getIntegrationConfig()).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith('settings listener: no connection');
    await m.getIntegrationConfig();
    expect(listen).toHaveBeenCalledTimes(2);
    await m.getIntegrationConfig();
    expect(listen).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
