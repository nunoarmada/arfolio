import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.js';

/**
 * Runs `fn` in a transaction scoped to one household. The id is set with a transaction-local
 * `set_config`, so it vanishes on commit/rollback and never leaks to other pool users.
 */
export async function withHousehold<T>(
  db: Db,
  householdId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!householdId) throw new Error('withHousehold: householdId must be a non-empty string');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.household_id', ${householdId}, true)`);
    return fn(tx);
  });
}
