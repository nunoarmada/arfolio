import { createDb, type Db } from '@arfolio/db';
import { getEnv } from './env';

let cached: Db | undefined;

/**
 * Lazily created pool connecting as `pfm_app` (RLS applies; use withHousehold for tenant data).
 * Max 11: one connection is held by the settings listener, leaving 10 for requests.
 */
export function getDb(): Db {
  cached ??= createDb(getEnv().DATABASE_URL, { max: 11 }).db;
  return cached;
}
