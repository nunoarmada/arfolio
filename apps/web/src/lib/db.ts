import { createDb, type Db } from '@arfolio/db';
import { getEnv } from './env';

let cached: Db | undefined;

/** Lazily created pool connecting as `pfm_app` (RLS applies; use withHousehold for tenant data). */
export function getDb(): Db {
  cached ??= createDb(getEnv().DATABASE_URL, { max: 10 }).db;
  return cached;
}
