import type { Db } from '@arfolio/db';
import { backfillHouseholdDefaults, matchTransfersForAllHouseholds } from '@arfolio/services';
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

/**
 * Repair sweep for transfer legs that arrived apart: re-runs the ingest matching over the last 30
 * days of every household. Idempotent, so it runs on every start. A failure is logged and does
 * not stop the worker; returns the number of pairs linked.
 */
export async function runStartupTransferRepair(db: Db): Promise<number> {
  try {
    const r = await matchTransfersForAllHouseholds(db, { days: 30 });
    if (r.paired > 0) log.info(`linked ${r.paired} late transfer pair(s)`);
    if (r.failed.length > 0) {
      log.error(`transfer repair failed for ${r.failed.length} household(s)`);
    }
    return r.paired;
  } catch (err) {
    log.error(`transfer repair failed: ${errorMessage(err)}`);
    return 0;
  }
}
