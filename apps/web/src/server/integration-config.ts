import { loadEncryptionKey } from '@arfolio/core/server';
import {
  createIntegrationConfigCache,
  listenForSettingsChanges,
  resolveIntegrationConfig,
  type IntegrationConfig,
} from '@arfolio/services';
import { getDb } from '../lib/db';
import { getEnv } from '../lib/env';

/** How long a resolved config is reused; saves from the UI call {@link invalidateIntegrationConfig}. */
export const INTEGRATION_CONFIG_TTL_MS = 30_000;

/**
 * Process-wide: every request reads the integration settings through this one cache, so a value
 * saved in the UI takes effect without a restart (env > DB > default, see the services resolver).
 */
const cache = createIntegrationConfigCache(
  () => resolveIntegrationConfig(getDb(), loadEncryptionKey(getEnv().ENCRYPTION_KEY), process.env),
  INTEGRATION_CONFIG_TTL_MS,
);

let listening = false;

/** Survives module re-evaluation (`next dev` reloads server modules), unlike a module variable. */
const LISTENER_KEY = Symbol.for('arfolio.settingsListener');
type ListenerHolder = { [LISTENER_KEY]?: { close(): Promise<void> } };

/**
 * Other processes (the worker, other web replicas) save settings too: the database announces every
 * change and this process drops its cache, so a removed key stops being used at once. Started on the
 * first read, next to the cache it feeds; the handle lives on `globalThis` so a re-evaluated module
 * closes the previous listener instead of leaking it. The TTL stays as a backstop.
 */
function listenForChanges(): void {
  if (listening) return;
  listening = true;
  const holder = globalThis as ListenerHolder;
  void holder[LISTENER_KEY]?.close().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'closing the settings listener failed');
  });
  holder[LISTENER_KEY] = listenForSettingsChanges(getDb().$client, invalidateIntegrationConfig, {
    onError: (message) => console.error(message),
  });
}

export const getIntegrationConfig = (): Promise<IntegrationConfig> => {
  listenForChanges();
  return cache.get();
};

/** Forgets the cached config; call after a save so the next read sees the new values. */
export const invalidateIntegrationConfig = (): void => cache.invalidate();
