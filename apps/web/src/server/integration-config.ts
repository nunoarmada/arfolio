import { loadEncryptionKey } from '@arfolio/core/server';
import {
  createIntegrationConfigCache,
  listenForSettingsChanges,
  resolveIntegrationConfig,
  type IntegrationConfig,
  type SettingsListener,
} from '@arfolio/services';
import { getDb } from '../lib/db';
import { getEnv } from '../lib/env';

/** How long a resolved config is reused; saves from the UI call {@link invalidateIntegrationConfig}. */
export const INTEGRATION_CONFIG_TTL_MS = 30_000;

type Load = () => Promise<IntegrationConfig>;
type State = {
  /** The loader of the module instance evaluated last (a dev reload replaces it). */
  load: Load;
  cache: { get(): Promise<IntegrationConfig>; invalidate(): void };
  /** Set only once the listener was created. */
  listener?: SettingsListener;
};

/**
 * One state per process, on `globalThis`: `next start` bundles this module twice (the page layer
 * and the server-action layer), and `next dev` re-evaluates it on reload. Every module instance
 * reads and invalidates the same cache, so a save in a server action is seen by the pages, and
 * one listener feeds it.
 */
const STATE_KEY = Symbol.for('arfolio.integrationConfig');
type Holder = { [STATE_KEY]?: State };

const load: Load = () =>
  resolveIntegrationConfig(getDb(), loadEncryptionKey(getEnv().ENCRYPTION_KEY), process.env);

function initState(): State {
  const holder = globalThis as Holder;
  const existing = holder[STATE_KEY];
  if (existing) {
    existing.load = load;
    return existing;
  }
  // The cache calls through `state.load`, so a reloaded module's loader is used from then on.
  const state: State = {
    load,
    cache: createIntegrationConfigCache(() => state.load(), INTEGRATION_CONFIG_TTL_MS),
  };
  holder[STATE_KEY] = state;
  return state;
}

const state = initState();

/**
 * Other processes (the worker, other web replicas) save settings too: the database announces every
 * change and this process drops its cache, so a removed key stops being used at once. Started on the
 * first read; a failed start is logged and tried again on the next read (the TTL stays as a backstop).
 */
function listenForChanges(): void {
  if (state.listener) return;
  try {
    state.listener = listenForSettingsChanges(getDb().$client, () => state.cache.invalidate(), {
      onError: (message) => console.error(message),
    });
  } catch (err) {
    console.error(
      `settings listener: ${err instanceof Error ? err.message : 'could not be started'}`,
    );
  }
}

/**
 * Process-wide: every request reads the integration settings through this one cache, so a value
 * saved in the UI takes effect without a restart (env > DB > default, see the services resolver).
 */
export const getIntegrationConfig = (): Promise<IntegrationConfig> => {
  listenForChanges();
  return state.cache.get();
};

/** Forgets the cached config; call after a save so the next read sees the new values. */
export const invalidateIntegrationConfig = (): void => state.cache.invalidate();
