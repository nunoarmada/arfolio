import {
  createEnableBankingClient,
  createTrading212Client,
  isUsableEnableBankingKey,
} from '@arfolio/connectors';
import { loadEncryptionKey } from '@arfolio/core/server';
import type { ConnectorDeps, IntegrationConfig } from '@arfolio/services';
import { getEnv, type Env } from '../lib/env';
import { getIntegrationConfig } from './integration-config';

/** Where the bank sends the user back to after the consent (carries `code` and `state`). */
export const CALLBACK_PATH = '/api/connections/callback';

type ConnectorEnv = Pick<Env, 'APP_URL' | 'ENCRYPTION_KEY' | 'TRADING212_API_URL'>;
type Bank = { appId: string; privateKey: string; apiUrl: string };

let loggedState: string | undefined;

/** Logs `message` once per distinct `state`, so a standing problem does not repeat on every request. */
function logOnce(state: string, message: string): void {
  if (loggedState === state) return;
  loggedState = state;
  console.error(message);
}

/**
 * The Enable Banking credentials when they are usable: app id and a well-formed RSA private key
 * are both set and readable. Anything else must not crash the app: it counts as not configured
 * and is logged once per distinct state (never the values).
 */
function usableBank(cfg: IntegrationConfig['enableBanking']): Bank | undefined {
  const { appId, privateKey, apiUrl } = cfg;
  if (appId.unreadable || privateKey.unreadable || apiUrl.unreadable) {
    logOnce(
      `unreadable:${appId.unreadable}:${privateKey.unreadable}:${apiUrl.unreadable}`,
      'Stored Enable Banking settings cannot be decrypted with the current ENCRYPTION_KEY; bank connections are disabled',
    );
    return undefined;
  }
  if (appId.value === undefined || privateKey.value === undefined || apiUrl.value === undefined) {
    loggedState = undefined;
    return undefined;
  }
  if (!isUsableEnableBankingKey(privateKey.value)) {
    logOnce(
      `bad-key:${JSON.stringify([appId.value, privateKey.value, apiUrl.value])}`,
      'The Enable Banking private key is not a valid RSA private key; bank connections are disabled',
    );
    return undefined;
  }
  loggedState = undefined;
  return { appId: appId.value, privateKey: privateKey.value, apiUrl: apiUrl.value };
}

/**
 * Provider deps from the validated environment and the resolved bank credentials. Enable Banking
 * is installation-level: with no usable app id and key there is no bank client and the bank
 * screens say so, while Trading 212 keeps working.
 */
function buildConnectorDeps(env: ConnectorEnv, bank: Bank | undefined): ConnectorDeps {
  return {
    encryptionKey: loadEncryptionKey(env.ENCRYPTION_KEY),
    ...(bank
      ? {
          enableBanking: createEnableBankingClient({
            appId: bank.appId,
            privateKeyPem: bank.privateKey,
            baseUrl: bank.apiUrl,
          }),
          bankRedirectUrl: new URL(CALLBACK_PATH, env.APP_URL).toString(),
        }
      : {}),
    trading212: (credentials) =>
      createTrading212Client({ ...credentials, baseUrl: env.TRADING212_API_URL }),
  };
}

let cached: { signature: string; deps: ConnectorDeps } | undefined;

/**
 * The deps for the current integration config. They are kept while app id, key and API URL stay
 * the same and rebuilt when any of them changes: `listBanks` keeps its 24 h bank-list cache per
 * Enable Banking client instance, so a client per request would defeat it.
 */
export async function getConnectorDeps(): Promise<ConnectorDeps> {
  const bank = usableBank((await getIntegrationConfig()).enableBanking);
  const signature = JSON.stringify(bank ?? null);
  if (cached?.signature === signature) return cached.deps;
  const deps = buildConnectorDeps(getEnv(), bank);
  cached = { signature, deps };
  return deps;
}

/** Whether bank connections are set up on this server (drives hidden/disabled bank UI). */
export async function bankingEnabled(): Promise<boolean> {
  return usableBank((await getIntegrationConfig()).enableBanking) !== undefined;
}
