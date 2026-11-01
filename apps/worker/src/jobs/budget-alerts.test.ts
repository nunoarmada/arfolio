import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@arfolio/db';
import {
  createBudget,
  createCategory,
  createCategoryGroup,
  linkCategories,
  setLineAmounts,
  upsertBudgetLine,
} from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import {
  BUDGET_ALERTS_CRON,
  enqueueBudgetAlerts,
  enqueueBudgetAlertsAll,
  registerBudgetAlerts,
  runBudgetAlertsJob,
} from './budget-alerts.js';

vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('budget-alerts jobs', () => {
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

  it('runs a pass for a household with no budget without error', async () => {
    const householdId = await household();
    await expect(runBudgetAlertsJob(db, { householdId })).resolves.toBeUndefined();
  });

  it('alerts end to end against a real household', async () => {
    const householdId = await household();
    const ctx = { db, householdId, userId: 'u1', role: 'owner' as const };
    const now = new Date('2026-06-15T10:00:00Z');
    const today = '2026-06-15';
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId, name: 'Hub', type: 'checking', currency: 'EUR' })
      .returning();
    const group = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
    const food = await createCategory(ctx, { groupId: group.id, name: 'Food' });
    const b = await createBudget(ctx, { startMonth: `${today.slice(0, 4)}-01-01` });
    const line = await upsertBudgetLine(ctx, b.id, { kind: 'expense', name: 'Food' });
    await setLineAmounts(
      ctx,
      line.id,
      Array.from({ length: 12 }, () => 10_000),
    );
    await linkCategories(ctx, line.id, [food.id]);
    await owner.insert(schema.transaction).values({
      householdId,
      accountId: account!.id,
      dedupeHash: 'e2e',
      bookingDate: today,
      amount: -11_000,
      currency: 'EUR',
      status: 'booked',
      rawDescription: 'x',
      source: 'manual',
      categoryId: food.id,
    });
    await runBudgetAlertsJob(db, { householdId }, now);
    const rows = await owner
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.householdId, householdId));
    // 110% of the plan in one go crosses 80 and 100: one alert, for the highest.
    expect(rows.map((r) => r.dedupeKey)).toEqual([
      `budget-line:${line.id}:${today.slice(0, 7)}:100`,
    ]);
  });

  it('rejects an invalid payload', async () => {
    await expect(runBudgetAlertsJob(db, { householdId: '' })).rejects.toThrow(
      /Invalid budget-alerts job/,
    );
  });

  it('queues a singleton job per household', async () => {
    const sent: unknown[][] = [];
    await enqueueBudgetAlerts(async (...args) => void sent.push(args), 'hh_1');
    expect(sent).toEqual([
      [QUEUES.budgetAlerts, { householdId: 'hh_1' }, { singletonKey: 'hh_1', retryLimit: 0 }],
    ]);
  });

  it('queues every household once', async () => {
    const a = await household();
    const b = await household();
    const sent: Array<{ name: string; data: { householdId: string }; singletonKey: string }> = [];
    await enqueueBudgetAlertsAll(db, async (name, data, options) => {
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
      sent.every((s) => s.name === QUEUES.budgetAlerts && s.singletonKey === s.data.householdId),
    ).toBe(true);
  });

  it('registers both queues and schedules the daily run at 08:15', async () => {
    const calls: string[] = [];
    let cron = '';
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const sent: Array<{ name: string; data: { householdId: string }; options: unknown }> = [];
    const boss = {
      send: async (name: string, data: { householdId: string }, options: unknown) =>
        void sent.push({ name, data, options }),
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
    await registerBudgetAlerts(boss, db, 'UTC');
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.budgetAlerts}`,
        `work:${QUEUES.budgetAlerts}`,
        `work:${QUEUES.budgetAlertsScheduler}`,
        `schedule:${QUEUES.budgetAlertsScheduler}`,
      ]),
    );
    expect(cron).toBe(BUDGET_ALERTS_CRON);
    expect(BUDGET_ALERTS_CRON).toBe('15 8 * * *');

    // The scheduler handler fans out one singleton job per household.
    const hh = await household();
    await handlers.get(QUEUES.budgetAlertsScheduler)!([{}]);
    const mine = sent.filter((s) => s.data.householdId === hh);
    expect(mine).toEqual([
      {
        name: QUEUES.budgetAlerts,
        data: { householdId: hh },
        options: { singletonKey: hh, retryLimit: 0 },
      },
    ]);
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
    await registerBudgetAlerts(boss, db, 'UTC', afterNotify);
    const run = handlers.get(QUEUES.budgetAlerts)!;

    await run([{ data: { householdId: await household() } }]);
    expect(afterNotify).toHaveBeenCalledTimes(1);

    await expect(run([{ data: { householdId: '' } }])).rejects.toThrow();
    expect(afterNotify).toHaveBeenCalledTimes(1);
  });
});
