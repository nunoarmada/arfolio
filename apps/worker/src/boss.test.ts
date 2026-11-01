import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../packages/db/test/pg.js';
import { startBoss } from './boss.js';
import { HEARTBEAT_KEY, registerHeartbeat } from './jobs/heartbeat.js';
import { registerSyncConnection } from './jobs/sync-connection.js';
import { registerSyncScheduler } from './jobs/sync-scheduler.js';
import { QUEUES } from './queues.js';

describe('worker boss wiring', () => {
  let testDb: TestDb;
  let db: Db;
  let boss: PgBoss;
  let end: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const created = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = created.db;
    end = () => created.pool.end();
    boss = await startBoss(testDb.appUrl(APP_PASSWORD));
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await end?.();
    await testDb?.drop();
  });

  it('runs a heartbeat job sent to the queue and registers its 5-minute schedule', async () => {
    await registerHeartbeat(boss, db, 'Europe/Berlin');
    const schedules = await boss.getSchedules();
    expect(schedules).toEqual([
      expect.objectContaining({ name: QUEUES.heartbeat, cron: '*/5 * * * *' }),
    ]);

    await boss.send(QUEUES.heartbeat, {});
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(schema.systemStatus)
              .where(eq(schema.systemStatus.key, HEARTBEAT_KEY))
          ).length,
        { timeout: 15_000, interval: 250 },
      )
      .toBe(1);
  });

  it('keeps at most one queued sync job per connection, whichever registration created the queue', async () => {
    // The worker registers the consumer first, the scheduler second: both must agree on the policy.
    await registerSyncConnection(boss, {} as never, {} as never);
    await registerSyncScheduler(boss, db, 'UTC');
    expect(await boss.getQueue(QUEUES.syncConnection)).toMatchObject({ policy: 'short' });

    // Deferred, so the consumer registered above never picks these probe jobs up.
    const opts = (singletonKey: string) => ({ singletonKey, startAfter: 3600 });
    const first = await boss.send(QUEUES.syncConnection, { n: 1 }, opts('conn-a'));
    const duplicate = await boss.send(QUEUES.syncConnection, { n: 2 }, opts('conn-a'));
    const other = await boss.send(QUEUES.syncConnection, { n: 3 }, opts('conn-b'));
    expect(first).toEqual(expect.any(String));
    expect(duplicate).toBeNull();
    expect(other).toEqual(expect.any(String));
  });
});
