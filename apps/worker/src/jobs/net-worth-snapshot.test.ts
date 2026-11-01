import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import {
  enqueueNetWorthSnapshot,
  enqueueNetWorthSnapshotAll,
  NET_WORTH_SNAPSHOT_CRON,
  registerNetWorthSnapshot,
  runNetWorthSnapshotJob,
} from './net-worth-snapshot.js';

vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('net-worth-snapshot jobs', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  const ends: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    const own = createDb(testDb.ownerUrl, { max: 2 });
    db = app.db;
    owner = own.db;
    ends.push(
      () => app.pool.end(),
      () => own.pool.end(),
    );
  });
  afterAll(async () => {
    for (const end of ends) await end();
    await testDb?.drop();
  });

  async function household(): Promise<string> {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId: id, timezone: 'UTC' });
    return id;
  }
  const snapshots = (householdId: string) =>
    owner
      .select()
      .from(schema.netWorthSnapshot)
      .where(eq(schema.netWorthSnapshot.householdId, householdId));

  it('stores the previous month and refreshes it on a rerun', async () => {
    const householdId = await household();
    await owner.insert(schema.financialAccount).values({
      householdId,
      name: 'Main',
      type: 'checking',
      currency: 'EUR',
      openingBalance: 25_000,
    });
    await runNetWorthSnapshotJob(db, { householdId }, new Date('2026-07-01T06:30:00Z'));
    expect(await snapshots(householdId)).toEqual([
      expect.objectContaining({ month: '2026-06-01', net: 25_000 }),
    ]);
    await owner
      .update(schema.financialAccount)
      .set({ openingBalance: 30_000 })
      .where(eq(schema.financialAccount.householdId, householdId));
    await runNetWorthSnapshotJob(db, { householdId }, new Date('2026-07-03T06:30:00Z'));
    expect(await snapshots(householdId)).toEqual([
      expect.objectContaining({ month: '2026-06-01', net: 30_000 }),
    ]);
  });

  it('rejects an invalid payload', async () => {
    await expect(runNetWorthSnapshotJob(db, { householdId: '' })).rejects.toThrow(
      /Invalid net-worth-snapshot job/,
    );
  });

  it('queues a singleton job per household', async () => {
    const sent: unknown[][] = [];
    await enqueueNetWorthSnapshot(async (...args) => void sent.push(args), 'hh_1');
    expect(sent).toEqual([
      [QUEUES.netWorthSnapshot, { householdId: 'hh_1' }, { singletonKey: 'hh_1', retryLimit: 0 }],
    ]);
  });

  it('queues every household once', async () => {
    const a = await household();
    const b = await household();
    const ids: string[] = [];
    await enqueueNetWorthSnapshotAll(db, async (_name, data) => {
      ids.push((data as { householdId: string }).householdId);
    });
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers both queues and schedules days 1 to 5 of each month at 06:30', async () => {
    const calls: string[] = [];
    let cron = '';
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const sent: Array<{ name: string; data: { householdId: string } }> = [];
    const boss = {
      send: async (name: string, data: { householdId: string }) => void sent.push({ name, data }),
      createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => {
        calls.push(`work:${n}`);
        handlers.set(n, h);
      },
      schedule: async (n: string, c: string) => {
        calls.push(`schedule:${n}`);
        cron = c;
      },
    } as unknown as PgBoss;
    await registerNetWorthSnapshot(boss, db, 'UTC');
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.netWorthSnapshot}`,
        `work:${QUEUES.netWorthSnapshot}`,
        `work:${QUEUES.netWorthSnapshotScheduler}`,
        `schedule:${QUEUES.netWorthSnapshotScheduler}`,
      ]),
    );
    expect(cron).toBe(NET_WORTH_SNAPSHOT_CRON);
    expect(NET_WORTH_SNAPSHOT_CRON).toBe('30 6 1-5 * *');

    const hh = await household();
    await handlers.get(QUEUES.netWorthSnapshotScheduler)!([{}]);
    expect(sent.filter((s) => s.data.householdId === hh)).toEqual([
      { name: QUEUES.netWorthSnapshot, data: { householdId: hh } },
    ]);
  });
});
