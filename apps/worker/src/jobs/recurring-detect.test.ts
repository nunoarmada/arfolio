import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import {
  enqueueRecurringDetect,
  enqueueRecurringDetectAll,
  RECURRING_DETECT_CRON,
  registerRecurringDetect,
  runRecurringDetectJob,
} from './recurring-detect.js';

vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('recurring-detect jobs', () => {
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

  it('detects the household named in the payload', async () => {
    const householdId = await household();
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId, name: 'Hub', type: 'checking', currency: 'EUR' })
      .returning();
    const today = new Date();
    const months = [3, 2, 1].map((back) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 5));
      return d.toISOString().slice(0, 10);
    });
    await owner.insert(schema.transaction).values(
      months.map((bookingDate, i) => ({
        householdId,
        accountId: account!.id,
        dedupeHash: `h${i}`,
        bookingDate,
        amount: -999,
        currency: 'EUR',
        status: 'booked' as const,
        rawDescription: 'Streaming',
        source: 'manual' as const,
      })),
    );
    await runRecurringDetectJob(db, { householdId });
    const rows = await owner
      .select()
      .from(schema.recurring)
      .where(eq(schema.recurring.householdId, householdId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'detected', cadence: 'monthly', amount: -999 });
  });

  it('rejects an invalid payload', async () => {
    await expect(runRecurringDetectJob(db, { householdId: '' })).rejects.toThrow(
      /Invalid recurring-detect job/,
    );
  });

  it('queues a singleton job per household', async () => {
    const sent: unknown[][] = [];
    await enqueueRecurringDetect(async (...args) => void sent.push(args), 'hh_1');
    expect(sent).toEqual([
      [QUEUES.recurringDetect, { householdId: 'hh_1' }, { singletonKey: 'hh_1', retryLimit: 0 }],
    ]);
  });

  it('queues every household once', async () => {
    const a = await household();
    const b = await household();
    const sent: Array<{ name: string; data: { householdId: string }; singletonKey: string }> = [];
    await enqueueRecurringDetectAll(db, async (name, data, options) => {
      sent.push({
        name,
        data: data as { householdId: string },
        singletonKey: options.singletonKey,
      });
    });
    const ids = sent.map((s) => s.data.householdId);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      sent.every((s) => s.name === QUEUES.recurringDetect && s.singletonKey === s.data.householdId),
    ).toBe(true);
  });

  it('registers both queues and schedules the daily run at 07:30', async () => {
    const calls: string[] = [];
    let cron = '';
    const boss = {
      createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
      work: async (n: string) => void calls.push(`work:${n}`),
      schedule: async (n: string, c: string) => {
        calls.push(`schedule:${n}`);
        cron = c;
      },
    } as unknown as PgBoss;
    await registerRecurringDetect(boss, db, 'UTC');
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.recurringDetect}`,
        `work:${QUEUES.recurringDetect}`,
        `work:${QUEUES.recurringScheduler}`,
        `schedule:${QUEUES.recurringScheduler}`,
      ]),
    );
    expect(cron).toBe(RECURRING_DETECT_CRON);
    expect(RECURRING_DETECT_CRON).toBe('30 7 * * *');
  });

  it('queues push delivery after a pass, and not when the pass fails', async () => {
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const boss = {
      createQueue: async () => {},
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) =>
        void handlers.set(n, h),
      schedule: async () => {},
    } as unknown as PgBoss;
    const afterNotify = vi.fn(async () => {});
    await registerRecurringDetect(boss, db, 'UTC', afterNotify);
    const run = handlers.get(QUEUES.recurringDetect)!;

    await run([{ data: { householdId: await household() } }]);
    expect(afterNotify).toHaveBeenCalledTimes(1);

    await expect(run([{ data: { householdId: '' } }])).rejects.toThrow();
    expect(afterNotify).toHaveBeenCalledTimes(1);
  });
});
