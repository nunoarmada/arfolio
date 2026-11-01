import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConfigFixture } from '../test-utils';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@arfolio/services', async (orig) => ({
  ...(await orig<typeof import('@arfolio/services')>()),
  resolveIntegrationConfig: resolve,
}));
vi.mock('../lib/db', () => ({ getDb: () => ({}) }));

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
});
