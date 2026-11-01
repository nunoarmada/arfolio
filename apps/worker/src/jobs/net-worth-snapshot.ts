import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import { findNetWorthHouseholds, snapshotPreviousMonth } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { SendWithOptions } from './recurring-detect.js';

/**
 * Days 1 to 5 of each month at 06:30, after the morning sync window (06:00): the 1st stores the
 * month that just ended and the next four days refresh it as late bank data arrives.
 */
export const NET_WORTH_SNAPSHOT_CRON = '30 6 1-5 * *';

const payload = z.strictObject({ householdId: z.string().min(1) });

/** Stores the previous month's net worth for a household (replacing any earlier run). */
export async function runNetWorthSnapshotJob(db: Db, data: unknown, now?: Date): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid net-worth-snapshot job payload');
  const row = await snapshotPreviousMonth({ db, ...(now ? { now } : {}) }, parsed.data.householdId);
  log.info(`net worth snapshot stored for ${row.month}`);
}

/**
 * Queues a snapshot for one household. The singleton key keeps at most one queued job per
 * household (the queue policy is `stately`). No retries: tomorrow's run repeats it.
 */
export async function enqueueNetWorthSnapshot(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(
    QUEUES.netWorthSnapshot,
    { householdId },
    { singletonKey: householdId, retryLimit: 0 },
  );
}

/** Queues a snapshot for every household. Returns how many. */
export async function enqueueNetWorthSnapshotAll(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findNetWorthHouseholds(db);
  for (const householdId of households) await enqueueNetWorthSnapshot(send, householdId);
  return households.length;
}

/** Registers the per-household job and the household-agnostic schedule that feeds it. */
export async function registerNetWorthSnapshot(boss: PgBoss, db: Db, tz: string): Promise<void> {
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await registerJob(
    boss,
    QUEUES.netWorthSnapshot,
    (job) => runNetWorthSnapshotJob(db, job.data),
    {},
    { policy: 'stately' },
  );
  await registerJob(boss, QUEUES.netWorthSnapshotScheduler, async () => {
    await enqueueNetWorthSnapshotAll(db, send);
  });
  await boss.schedule(QUEUES.netWorthSnapshotScheduler, NET_WORTH_SNAPSHOT_CRON, null, { tz });
}
