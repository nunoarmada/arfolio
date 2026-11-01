import type { Db } from '@arfolio/db';
import { backfillHouseholdDefaults } from '@arfolio/services';
import { errorMessage, log } from './log.js';

/**
 * Gives households that have no categories yet the default templates. Idempotent, so it runs on
 * every start. A failure is logged and does not stop the worker (the next start retries);
 * returns the number of households seeded.
 */
export async function runStartupBackfill(db: Db): Promise<number> {
  try {
    const seeded = await backfillHouseholdDefaults(db);
    if (seeded > 0) log.info(`seeded default categories for ${seeded} household(s)`);
    return seeded;
  } catch (err) {
    log.error(`household defaults backfill failed: ${errorMessage(err)}`);
    return 0;
  }
}
