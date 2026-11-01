import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationConfigFixture } from '../test-utils';

const getIntegrationConfig = vi.hoisted(() => vi.fn());
vi.mock('./integration-config', () => ({ getIntegrationConfig }));

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const broken = '-----BEGIN PRIVATE KEY-----\ngarbage-garbage\n-----END PRIVATE KEY-----';

function stubEnv(): void {
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('BETTER_AUTH_URL', 'https://pfm.example.test');
  vi.stubEnv('APP_URL', 'https://pfm.example.test');
  vi.stubEnv('SETUP_TOKEN', 'y'.repeat(24));
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
}

async function fresh() {
  vi.resetModules();
  return import('./connector-deps');
}

beforeEach(() => {
  stubEnv();
  getIntegrationConfig.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('getConnectorDeps', () => {
  it('has no bank client and no redirect URL until Enable Banking is configured', async () => {
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture({ appId: 'app' }));
    const m = await fresh();
    const deps = await m.getConnectorDeps();
    expect(deps.enableBanking).toBeUndefined();
    expect(deps.bankRedirectUrl).toBeUndefined();
    expect(deps.encryptionKey).toHaveLength(32);
    expect(await m.bankingEnabled()).toBe(false);
  });

  it('builds the bank client and the callback URL from the public app URL', async () => {
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: pem }),
    );
    const m = await fresh();
    const deps = await m.getConnectorDeps();
    expect(typeof deps.enableBanking?.listAspsps).toBe('function');
    expect(deps.bankRedirectUrl).toBe(`https://pfm.example.test${m.CALLBACK_PATH}`);
    expect(await m.bankingEnabled()).toBe(true);
  });

  it('points Trading 212 at the configured base URL', async () => {
    vi.stubEnv('TRADING212_API_URL', 'http://127.0.0.1:9/api/v0');
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture());
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        urls.push(String(url));
        return Promise.resolve(new Response('{}', { status: 500 }));
      }),
    );
    const m = await fresh();
    await (
      await m.getConnectorDeps()
    )
      .trading212({ apiKey: 'k', apiSecret: 's' })
      .getAccountSummary()
      .catch(() => undefined);
    expect(urls).toEqual(['http://127.0.0.1:9/api/v0/equity/account/summary']);
  });

  it('reuses the deps while app id, key and URL stay the same, so the bank-list cache survives', async () => {
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: pem }),
    );
    const m = await fresh();
    const first = await m.getConnectorDeps();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: pem }),
    );
    const second = await m.getConnectorDeps();
    expect(second).toBe(first);
    expect(second.enableBanking).toBe(first.enableBanking);
  });

  it('rebuilds the deps when the resolved app id changes', async () => {
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app-1', privateKey: pem }),
    );
    const m = await fresh();
    const first = await m.getConnectorDeps();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app-2', privateKey: pem }),
    );
    const second = await m.getConnectorDeps();
    expect(second).not.toBe(first);
    expect(second.enableBanking).not.toBe(first.enableBanking);
  });

  it('drops the bank client when the credentials are removed', async () => {
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: pem }),
    );
    const m = await fresh();
    expect((await m.getConnectorDeps()).enableBanking).toBeDefined();
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture());
    expect((await m.getConnectorDeps()).enableBanking).toBeUndefined();
    expect(await m.bankingEnabled()).toBe(false);
  });
});

describe('a malformed Enable Banking private key', () => {
  it('is treated as banking not configured, and logged once without the value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: broken }),
    );
    const m = await fresh();

    expect((await m.getConnectorDeps()).enableBanking).toBeUndefined();
    expect(await m.bankingEnabled()).toBe(false);
    await m.getConnectorDeps();
    expect(await m.bankingEnabled()).toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('Enable Banking private key');
    expect(line).not.toContain('garbage');
  });

  it('logs again for a different malformed key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: broken }),
    );
    const m = await fresh();
    await m.bankingEnabled();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: `${broken}\nmore` }),
    );
    await m.bankingEnabled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('does not log for a valid key or for none at all', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await fresh();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ appId: 'app', privateKey: pem }),
    );
    expect(await m.bankingEnabled()).toBe(true);
    getIntegrationConfig.mockResolvedValue(integrationConfigFixture());
    expect(await m.bankingEnabled()).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('unreadable stored bank credentials', () => {
  it('disable banking and log one line per distinct state, never a value', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await fresh();
    getIntegrationConfig.mockResolvedValue(
      integrationConfigFixture({ unreadable: ['appId', 'privateKey'] }),
    );
    expect(await m.bankingEnabled()).toBe(false);
    expect(await m.bankingEnabled()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('ENCRYPTION_KEY');

    getIntegrationConfig.mockResolvedValue(integrationConfigFixture({ unreadable: ['appId'] }));
    await m.bankingEnabled();
    expect(error).toHaveBeenCalledTimes(2);
  });
});
