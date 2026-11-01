import { loadEncryptionKey } from '@arfolio/core/server';
import {
  createIntegrationConfigCache,
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

export const getIntegrationConfig = (): Promise<IntegrationConfig> => cache.get();

/** Forgets the cached config; call after a save so the next read sees the new values. */
export const invalidateIntegrationConfig = (): void => cache.invalidate();
