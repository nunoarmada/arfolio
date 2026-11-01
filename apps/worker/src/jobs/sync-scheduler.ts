import type { PgBoss } from 'pg-boss';
import type { Db } from '@arfolio/db';
import { findDueConnections } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { QUEUES, SYNC_QUEUE_OPTIONS } from '../queues.js';

export const SYNC_SCHEDULER_CRON = '*/15 * * * *';

export type SendJob = (
  name: string,
  data: object,
  options?: { singletonKey: string },
) => Promise<unknown>;

/**
 * Queues one `sync-connection` job per active connection whose `next_sync_at` has passed.
 * The connection id is the job's singleton key, so a connection already waiting in the queue is
 * not queued again; and enqueuing twice is harmless anyway: the sync itself skips a connection
 * that is no longer due or is already running. Returns the number of due connections.
 */
export async function enqueueDueSyncs(
  db: Db,
  send: SendJob,
  now: Date = new Date(),
): Promise<number> {
  const due = await findDueConnections(db, now);
  for (const job of due) {
    await send(QUEUES.syncConnection, job, { singletonKey: job.connectionId });
  }
  return due.length;
}

export async function registerSyncScheduler(boss: PgBoss, db: Db, tz: string): Promise<void> {
  await boss.createQueue(QUEUES.syncConnection, SYNC_QUEUE_OPTIONS);
  await registerJob(boss, QUEUES.syncScheduler, async () => {
    // A failed sync is recorded on its run; pg-boss must not retry it against the provider.
    await enqueueDueSyncs(db, (name, data, options) =>
      boss.send(name, data, { ...options, retryLimit: 0 }),
    );
  });
  await boss.schedule(QUEUES.syncScheduler, SYNC_SCHEDULER_CRON, null, { tz });
}
