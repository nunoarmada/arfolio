import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConfigFixture } from '../test-utils';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@arfolio/services', async (orig) => ({
  ...(await orig<typeof import('@arfolio/services')>()),
  resolveIntegrationConfig: resolve,
}));
vi.mock('../lib/db', () => ({ getDb: () => ({}) }));

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
});
