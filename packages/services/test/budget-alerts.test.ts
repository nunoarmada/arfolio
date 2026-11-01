import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import {
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  findBudgetAlertHouseholds,
  linkCategories,
  runBudgetAlerts,
  setHubAccount,
  setLineAmounts,
  upsertBudgetLine,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { transaction, householdSettings, notification } = schema;
const flat = (n: number): number[] => Array.from({ length: 12 }, () => n);
const NOW = new Date('2026-03-20T10:00:00Z');

describe('budget alerts', () => {
  let t: ServicesTestDb;
  let hashN = 0;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world(thresholds?: number[]) {
    const ctx = await t.household({ currency: 'EUR' });
    await t.owner
      .update(householdSettings)
      .set({ timezone: 'UTC', ...(thresholds ? { budgetAlertThresholds: thresholds } : {}) })
      .where(eq(householdSettings.householdId, ctx.householdId));
    const hub = await createAccount(ctx, { name: 'Hub', type: 'checking' });
    const gInc = await createCategoryGroup(ctx, { name: 'Income', kind: 'income' });
    const gExp = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
    const salary = (await createCategory(ctx, { groupId: gInc.id, name: 'Salary' })).id;
    const food = (await createCategory(ctx, { groupId: gExp.id, name: 'Food' })).id;
    const fuel = (await createCategory(ctx, { groupId: gExp.id, name: 'Fuel' })).id;
    const spend = async (categoryId: string, amount: number, bookingDate = '2026-03-10') =>
      withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.insert(transaction).values({
          householdId: ctx.householdId,
          accountId: hub.id,
          dedupeHash: `a${(hashN += 1)}`,
          bookingDate,
          amount,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'x',
          source: 'manual',
          categoryId,
        }),
      );
    const line = async (
      budgetId: string,
      kind: 'income' | 'expense',
      name: string,
      planned: number,
      categoryId: string,
    ) => {
      const l = await upsertBudgetLine(ctx, budgetId, { kind, name });
      await setLineAmounts(ctx, l.id, flat(planned));
      await linkCategories(ctx, l.id, [categoryId]);
      return l;
    };
    return { ctx, hub, cats: { salary, food, fuel }, spend, line };
  }

  const alerts = async (ctx: ServiceCtx) =>
    t.owner.select().from(notification).where(eq(notification.householdId, ctx.householdId));

  it('notifies once per threshold crossed, and not again on a rerun', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    const food = await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -8_500);

    const first = await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    expect(first).toEqual({ lineAlerts: 1, unallocatedAlerts: 0 });
    let rows = await alerts(w.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'budget_line_threshold',
      userId: null,
      dedupeKey: `budget-line:${food.id}:2026-03:80`,
      payload: {
        budgetId: b.id,
        lineId: food.id,
        monthIndex: 3,
        threshold: 80,
        planned: 10_000,
        actual: 8_500,
      },
    });

    expect(await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).toEqual({
      lineAlerts: 0,
      unallocatedAlerts: 0,
    });

    await w.spend(w.cats.food, -2_000);
    const third = await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    expect(third.lineAlerts).toBe(1);
    rows = await alerts(w.ctx);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [`budget-line:${food.id}:2026-03:100`, `budget-line:${food.id}:2026-03:80`].sort(),
    );
  });

  it('notifies only the highest threshold crossed at once, and ignores a line below the lowest', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    const food = await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.line(b.id, 'expense', 'Fuel', 10_000, w.cats.fuel);
    await w.spend(w.cats.food, -12_000);
    await w.spend(w.cats.fuel, -7_900);
    const r = await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    expect(r.lineAlerts).toBe(1);
    expect((await alerts(w.ctx)).map((a) => a.dedupeKey)).toEqual([
      `budget-line:${food.id}:2026-03:100`,
    ]);
  });

  it('does not send a lower threshold after a higher one was notified (spend dips and returns)', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -12_000);
    expect((await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).lineAlerts).toBe(1);
    await w.spend(w.cats.food, 3_500); // refund: 85% now
    expect((await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).lineAlerts).toBe(0);
    expect(await alerts(w.ctx)).toHaveLength(1);
  });

  it('does not alert on a line with nothing planned', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await w.line(b.id, 'expense', 'Food', 0, w.cats.food);
    await w.spend(w.cats.food, -5_000);
    expect(await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).toEqual({
      lineAlerts: 0,
      unallocatedAlerts: 0,
    });
    expect(await alerts(w.ctx)).toHaveLength(0);
  });

  it('only notifies expense lines', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await w.line(b.id, 'income', 'Salary', 1_000, w.cats.salary);
    await w.spend(w.cats.salary, 5_000);
    expect((await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).lineAlerts).toBe(0);
  });

  it('does nothing when no budget covers today', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2025-01-01' });
    await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -20_000, '2025-03-10');
    expect(await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).toEqual({
      lineAlerts: 0,
      unallocatedAlerts: 0,
    });
    expect(await alerts(w.ctx)).toHaveLength(0);
  });

  it('uses the budget whose year contains today, with a non-January start', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2025-10-01' });
    const food = await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -9_000);
    await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    const rows = await alerts(w.ctx);
    expect(rows[0]).toMatchObject({
      dedupeKey: `budget-line:${food.id}:2026-03:80`,
      payload: { monthIndex: 6 },
    });
  });

  it('picks the latest-starting active budget when several cover today, ignoring archived', async () => {
    const w = await world();
    const older = await createBudget(w.ctx, { startMonth: '2025-06-01' });
    const newer = await createBudget(w.ctx, { startMonth: '2025-12-01' });
    const archived = await createBudget(w.ctx, { startMonth: '2026-02-01' });
    await t.owner
      .update(schema.budget)
      .set({ status: 'archived' })
      .where(eq(schema.budget.id, archived.id));
    await w.line(older.id, 'expense', 'Old food', 10_000, w.cats.food);
    const food = await w.line(newer.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -9_000);
    await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    const rows = await alerts(w.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: `budget-line:${food.id}:2026-03:80`,
      payload: { budgetId: newer.id, monthIndex: 4 },
    });
  });

  it('decides the month in the household timezone near a month boundary', async () => {
    const w = await world();
    await t.owner
      .update(householdSettings)
      .set({ timezone: 'Pacific/Auckland' })
      .where(eq(householdSettings.householdId, w.ctx.householdId));
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    const food = await w.line(b.id, 'expense', 'Food', 10_000, w.cats.food);
    await w.spend(w.cats.food, -9_000, '2026-04-01');
    // 2026-03-31T23:30Z is already 2026-04-01 in Auckland (UTC+13 until 5 April), still March in UTC.
    await runBudgetAlerts({ db: t.db, now: new Date('2026-03-31T23:30:00Z') }, w.ctx.householdId);
    expect((await alerts(w.ctx)).map((r) => r.dedupeKey)).toEqual([
      `budget-line:${food.id}:2026-04:80`,
    ]);
  });

  it('turns line alerts off with empty thresholds and honours custom ones', async () => {
    const off = await world([]);
    const b1 = await createBudget(off.ctx, { startMonth: '2026-01-01' });
    await off.line(b1.id, 'expense', 'Food', 10_000, off.cats.food);
    await off.spend(off.cats.food, -20_000);
    expect((await runBudgetAlerts({ db: t.db, now: NOW }, off.ctx.householdId)).lineAlerts).toBe(0);

    const custom = await world([50, 150]);
    const b2 = await createBudget(custom.ctx, { startMonth: '2026-01-01' });
    const food = await custom.line(b2.id, 'expense', 'Food', 10_000, custom.cats.food);
    await custom.spend(custom.cats.food, -6_000);
    await runBudgetAlerts({ db: t.db, now: NOW }, custom.ctx.householdId);
    expect((await alerts(custom.ctx)).map((r) => r.dedupeKey)).toEqual([
      `budget-line:${food.id}:2026-03:50`,
    ]);
  });

  it('notifies once a month when the hub remainder is negative', async () => {
    const w = await world();
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await w.line(b.id, 'income', 'Salary', 100_000, w.cats.salary);
    await w.line(b.id, 'expense', 'Food', 150_000, w.cats.food);
    await setHubAccount(w.ctx, w.hub.id);
    const r = await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId);
    expect(r.unallocatedAlerts).toBe(1);
    const rows = (await alerts(w.ctx)).filter((n) => n.kind === 'budget_unallocated_negative');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupeKey: `budget-unallocated:${b.id}:2026-03`,
      payload: { budgetId: b.id, monthIndex: 3, remainingInHub: -50_000 },
    });
    expect(
      (await runBudgetAlerts({ db: t.db, now: NOW }, w.ctx.householdId)).unallocatedAlerts,
    ).toBe(0);
  });

  it('skips the unallocated alert without a hub or with a positive remainder', async () => {
    const noHub = await world();
    const b1 = await createBudget(noHub.ctx, { startMonth: '2026-01-01' });
    await noHub.line(b1.id, 'income', 'Salary', 100_000, noHub.cats.salary);
    await noHub.line(b1.id, 'expense', 'Food', 150_000, noHub.cats.food);
    expect(
      (await runBudgetAlerts({ db: t.db, now: NOW }, noHub.ctx.householdId)).unallocatedAlerts,
    ).toBe(0);

    const ok = await world();
    const b2 = await createBudget(ok.ctx, { startMonth: '2026-01-01' });
    await ok.line(b2.id, 'income', 'Salary', 200_000, ok.cats.salary);
    await ok.line(b2.id, 'expense', 'Food', 150_000, ok.cats.food);
    await setHubAccount(ok.ctx, ok.hub.id);
    expect(
      (await runBudgetAlerts({ db: t.db, now: NOW }, ok.ctx.householdId)).unallocatedAlerts,
    ).toBe(0);
  });

  it('lists every household for the scheduler', async () => {
    const w = await world();
    expect(await findBudgetAlertHouseholds(t.db)).toContain(w.ctx.householdId);
  });
});
