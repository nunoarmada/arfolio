import type { PgBoss } from 'pg-boss';
import { schema, type Db } from '@arfolio/db';
import { registerJob } from '../boss.js';
import { QUEUES } from '../queues.js';

export const HEARTBEAT_KEY = 'worker.heartbeat';
export const HEARTBEAT_CRON = '*/5 * * * *';

/** Records "the worker is alive" in system_status; the single row is overwritten each run. */
export async function writeHeartbeat(db: Db, now: Date = new Date()): Promise<void> {
  const value = { at: now.toISOString() };
  await db
    .insert(schema.systemStatus)
    .values({ key: HEARTBEAT_KEY, value })
    .onConflictDoUpdate({
      target: schema.systemStatus.key,
      set: { value, updatedAt: now },
    });
}

export async function registerHeartbeat(boss: PgBoss, db: Db, tz: string): Promise<void> {
  await registerJob(boss, QUEUES.heartbeat, () => writeHeartbeat(db));
  await boss.schedule(QUEUES.heartbeat, HEARTBEAT_CRON, null, { tz });
}
