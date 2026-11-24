import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  declareRecurring,
  linkCategories,
  loadSpendingProfile,
  seedCategoryTemplates,
  upsertBudgetLine,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { transaction, financialAccount } = schema;
const TODAY = '2026-11-24';

describe('loadSpendingProfile', () => {
  let t: ServicesTestDb;
  let hash = 0;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world() {
    const ctx = await t.household({ currency: 'EUR', locale: 'en' });
    await seedCategoryTemplates(ctx, 'en');
    const main = (await createAccount(ctx, { name: 'Main', type: 'checking' })).id;
    const gFood = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
    const gWork = await createCategoryGroup(ctx, { name: 'Work', kind: 'income' });
    const restaurants = (await createCategory(ctx, { groupId: gFood.id, name: 'Restaurants' })).id;
    const groceries = (await createCategory(ctx, { groupId: gFood.id, name: 'Groceries' })).id;
    const salary = (await createCategory(ctx, { groupId: gWork.id, name: 'Salary' })).id;
    const add = (
      accountId: string,
      bookingDate: string,
      amount: number,
      extra: {
        categoryId?: string;
        transferGroupId?: string;
        status?: 'booked' | 'pending';
      } = {},
    ) =>
      t.owner.insert(transaction).values({
        householdId: ctx.householdId,
        accountId,
        dedupeHash: `p${(hash += 1)}`,
        bookingDate,
        amount,
        currency: 'EUR',
        status: extra.status ?? 'booked',
        rawDescription: 'x',
        source: 'manual',
        ...(extra.categoryId ? { categoryId: extra.categoryId } : {}),
        ...(extra.transferGroupId ? { transferGroupId: extra.transferGroupId } : {}),
      });
    return { ctx, main, cats: { restaurants, groceries, salary }, add };
  }

  /** One restaurant outflow on the 1st of each month, plus a salary on the 2nd. */
  async function seedMonths(
    w: Awaited<ReturnType<typeof world>>,
    months: string[],
    spend = 20_000,
  ) {
    for (const m of months) {
      await w.add(w.main, `${m}-01`, -spend, { categoryId: w.cats.restaurants });
      await w.add(w.main, `${m}-02`, 300_000, { categoryId: w.cats.salary });
    }
  }

  it('is not ready with two complete months and gives no typical figures', async () => {
    const w = await world();
    await seedMonths(w, ['2026-09', '2026-10', '2026-11']);
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p.learning).toEqual({ ready: false, completeMonths: 2, required: 3 });
    expect(p.currency).toBe('EUR');
    expect(p.window).toEqual(['2026-09', '2026-10']);
    expect(p.categories.length).toBeGreaterThan(0);
    expect(p.categories.every((c) => c.typical === null)).toBe(true);
    expect(p.income).toBeNull();
  });

  it('is ready with four months and reports the seeded restaurant median', async () => {
    const w = await world();
    await seedMonths(w, ['2026-07', '2026-08', '2026-09', '2026-10']);
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p.learning).toEqual({ ready: true, completeMonths: 4, required: 3 });
    expect(p.window).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(p.categories).toEqual([
      {
        categoryId: w.cats.restaurants,
        name: 'Restaurants',
        group: 'Food',
        typical: { median: 20_000, min: 20_000, max: 20_000, months: 4, outlierMonths: [] },
      },
    ]);
    expect(p.income).toMatchObject({ median: 300_000, months: 4 });
  });

  it('still reports typical figures when the learning period is longer than the six-month window', async () => {
    const w = await world();
    await seedMonths(w, [
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 8, today: TODAY });
    expect(p.learning).toEqual({ ready: true, completeMonths: 8, required: 8 });
    expect(p.window).toHaveLength(6);
    expect(p.categories[0]!.typical).toMatchObject({ median: 20_000, months: 6 });
    expect(p.income).toMatchObject({ median: 300_000, months: 6 });
  });

  it('leaves a category without enough months of data at null', async () => {
    const w = await world();
    await seedMonths(w, ['2026-07', '2026-08', '2026-09', '2026-10']);
    await w.add(w.main, '2026-10-05', -5_000, { categoryId: w.cats.groceries });
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    const groceries = p.categories.find((c) => c.categoryId === w.cats.groceries);
    expect(groceries).toMatchObject({ name: 'Groceries', typical: null });
    expect(p.categories.find((c) => c.categoryId === w.cats.restaurants)!.typical).not.toBeNull();
  });

  it('flags an outlier month and keeps it out of min and max', async () => {
    const w = await world();
    const spend = [21_000, 18_000, 24_000, 90_000];
    for (const [i, m] of ['2026-07', '2026-08', '2026-09', '2026-10'].entries()) {
      await w.add(w.main, `${m}-01`, -spend[i]!, { categoryId: w.cats.restaurants });
    }
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p.categories[0]!.typical).toEqual({
      median: 22_500,
      min: 18_000,
      max: 24_000,
      months: 4,
      outlierMonths: [3],
    });
  });

  it('ignores transfers, pending rows and the history of archived accounts', async () => {
    const w = await world();
    const old = (await createAccount(w.ctx, { name: 'Old', type: 'checking' })).id;
    await w.add(old, '2026-01-05', -100);
    await t.owner
      .update(financialAccount)
      .set({ archivedAt: new Date() })
      .where(eq(financialAccount.id, old));
    await seedMonths(w, ['2026-07', '2026-08', '2026-09', '2026-10']);
    await w.add(w.main, '2026-08-03', -50_000, { transferGroupId: randomUUID() });
    await w.add(w.main, '2026-09-03', -70_000, {
      categoryId: w.cats.restaurants,
      status: 'pending',
    });
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p.learning.completeMonths).toBe(4);
    expect(p.categories[0]!.typical).toMatchObject({ median: 20_000, max: 20_000 });
  });

  it('adds recurring cost and expense budget lines with their updated_at', async () => {
    const w = await world();
    await seedMonths(w, ['2026-07', '2026-08', '2026-09', '2026-10']);
    await declareRecurring(w.ctx, { name: 'Gym', amount: -4_500, cadence: 'monthly' });
    const budget = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    const eating = await upsertBudgetLine(w.ctx, budget.id, {
      kind: 'expense',
      name: 'Eating out',
    });
    await linkCategories(w.ctx, eating.id, [w.cats.restaurants]);
    await upsertBudgetLine(w.ctx, budget.id, { kind: 'income', name: 'Pay' });
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p.recurringMonthly).toBe(4_500);
    expect(p.budgetLines).toHaveLength(1);
    expect(p.budgetLines[0]).toMatchObject({
      lineId: eating.id,
      name: 'Eating out',
      typical: { median: 20_000, months: 4 },
    });
    expect(new Date(p.budgetLines[0]!.updatedAt).toISOString()).toBe(p.budgetLines[0]!.updatedAt);
  });

  it('is empty and not ready for a household without data', async () => {
    const w = await world();
    const p = await loadSpendingProfile(w.ctx, { learningMonths: 3, today: TODAY });
    expect(p).toMatchObject({
      learning: { ready: false, completeMonths: 0, required: 3 },
      window: [],
      categories: [],
      income: null,
      recurringMonthly: 0,
      budgetLines: [],
    });
  });
});
