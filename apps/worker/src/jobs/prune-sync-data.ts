import type { PgBoss } from 'pg-boss';
import type { Db } from '@arfolio/db';
import { pruneSyncData } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';

export const PRUNE_SYNC_DATA_CRON = '41 3 * * *';

/** Deletes consent states older than a day, sync runs older than 180 days, test notifications older than two days and unconsented OAuth clients older than a week. */
export async function runPruneSyncData(
  db: Db,
  now: Date = new Date(),
): Promise<{ consentStates: number; syncRuns: number; pushTests: number; oauthClients: number }> {
  const totals = await pruneSyncData(db, { now });
  if (totals.consentStates + totals.syncRuns + totals.pushTests + totals.oauthClients > 0) {
    log.info(
      `pruned ${totals.consentStates} consent states, ${totals.syncRuns} sync runs, ${totals.pushTests} test notifications, ${totals.oauthClients} unused oauth clients`,
    );
  }
  return totals;
}

export async function registerPruneSyncData(boss: PgBoss, db: Db, tz: string): Promise<void> {
  await registerJob(boss, QUEUES.pruneSyncData, async () => {
    await runPruneSyncData(db);
  });
  await boss.schedule(QUEUES.pruneSyncData, PRUNE_SYNC_DATA_CRON, null, { tz });
}
