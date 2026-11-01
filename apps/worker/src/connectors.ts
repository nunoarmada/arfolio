import {
  createEnableBankingClient,
  createTrading212Client,
  isUsableEnableBankingKey,
} from '@arfolio/connectors';
import type { ConnectorDeps, IntegrationConfig } from '@arfolio/services';
import { log } from './log.js';

/** Trading 212 live API (default of TRADING212_API_URL). The key pair is stored per connection. */
export const TRADING212_API_URL = 'https://live.trading212.com/api/v0';

type Bank = NonNullable<ConnectorDeps['enableBanking']>;

/**
 * Provider clients for the sync jobs, built from the integration config of each run. Enable
 * Banking is an installation-level integration: without its app id and key there is no bank
 * client and bank syncs fail with a clear code, while Trading 212 keeps working. The worker never
 * starts a bank consent, so it needs no redirect URL.
 *
 * The bank client is kept while app id, key and API URL stay the same and rebuilt when any of
 * them changes. A malformed key logs one line per distinct config (never the key) and disables
 * banking for the run, so a bad stored key cannot stop the worker or spam the log.
 */
export function createWorkerConnectors(opts: {
  encryptionKey: Buffer;
  /** TRADING212_API_URL; the live API when absent. */
  trading212ApiUrl?: string;
}): (cfg: IntegrationConfig) => ConnectorDeps {
  let bank: { signature: string; client: Bank } | undefined;
  let rejected: string | undefined;

  const bankClient = (cfg: IntegrationConfig['enableBanking']): Bank | undefined => {
    const appId = cfg.appId.value;
    const privateKey = cfg.privateKey.value;
    const baseUrl = cfg.apiUrl.value;
    if (appId === undefined || privateKey === undefined || baseUrl === undefined) {
      bank = undefined;
      rejected = undefined;
      return undefined;
    }
    const signature = JSON.stringify([appId, privateKey, baseUrl]);
    if (bank?.signature === signature) return bank.client;
    if (!isUsableEnableBankingKey(privateKey)) {
      bank = undefined;
      if (rejected !== signature) {
        rejected = signature;
        log.error(
          'The Enable Banking private key is not a valid RSA private key; bank syncs are disabled',
        );
      }
      return undefined;
    }
    rejected = undefined;
    const client = createEnableBankingClient({ appId, privateKeyPem: privateKey, baseUrl });
    bank = { signature, client };
    return client;
  };

  return (cfg) => {
    const enableBanking = bankClient(cfg.enableBanking);
    return {
      encryptionKey: opts.encryptionKey,
      ...(enableBanking ? { enableBanking } : {}),
      trading212: (credentials) =>
        createTrading212Client({
          ...credentials,
          baseUrl: opts.trading212ApiUrl ?? TRADING212_API_URL,
        }),
    };
  };
}
