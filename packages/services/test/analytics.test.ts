import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  cashFlow,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  monthlyTrends,
  seedCategoryTemplates,
  setHubAccount,
  spendingByGroup,
  summariseMonth,
  upsertBudgetLine,
  ValidationError,
} from '../src/index.js';
import { findTransferCategory } from '../src/transactions.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { transaction, householdSettings } = schema;

describe('analytics', () => {
  let t: ServicesTestDb;
  let hash = 0;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world(timezone = 'UTC') {
    const ctx = await t.household({ currency: 'EUR', locale: 'en' });
    await t.owner
      .update(householdSettings)
      .set({ timezone })
      .where(eq(householdSettings.householdId, ctx.householdId));
    await seedCategoryTemplates(ctx, 'en');
    const transferId = (await withHousehold(ctx.db, ctx.householdId, (tx) =>
      findTransferCategory(tx, ctx.householdId),
    ))!;
    const main = (await createAccount(ctx, { name: 'Main', type: 'checking' })).id;
    const sav = (await createAccount(ctx, { name: 'Savings', type: 'savings' })).id;
    const gFood = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
    const gHome = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
    const groceries = (await createCategory(ctx, { groupId: gFood.id, name: 'Groceries' })).id;
    const dining = (await createCategory(ctx, { groupId: gFood.id, name: 'Dining' })).id;
    const rent = (await createCategory(ctx, { groupId: gHome.id, name: 'Rent' })).id;
    const add = (
      accountId: string,
      bookingDate: string,
      amount: number,
      extra: {
        categoryId?: string;
        transferGroupId?: string;
        currency?: string;
        status?: 'booked' | 'pending';
        transactionDate?: string;
      } = {},
    ) =>
      t.owner.insert(transaction).values({
        householdId: ctx.householdId,
        accountId,
        dedupeHash: `a${(hash += 1)}`,
        bookingDate,
        amount,
        currency: extra.currency ?? 'EUR',
        status: extra.status ?? 'booked',
        rawDescription: 'x',
        source: 'manual',
        ...(extra.categoryId ? { categoryId: extra.categoryId } : {}),
        ...(extra.transferGroupId ? { transferGroupId: extra.transferGroupId } : {}),
        ...(extra.transactionDate ? { transactionDate: extra.transactionDate } : {}),
      });
    return {
      ctx,
      transferId,
      main,
      sav,
      groups: { food: gFood.id, home: gHome.id },
      cats: { groceries, dining, rent },
      add,
    };
  }
  const range = { from: '2026-08-01', to: '2026-08-31' };

  describe('transfer rule (Review Focus 1)', () => {
    it('a category-only transfer is not spending in analytics nor in the home summary', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -1_000, { categoryId: w.cats.groceries });
      await w.add(w.main, '2026-08-03', -50_000, { categoryId: w.transferId });
      await w.add(w.sav, '2026-08-03', 50_000, { categoryId: w.transferId });
      await w.add(w.main, '2026-08-04', -7_000, { transferGroupId: randomUUID() });

      const s = await spendingByGroup(w.ctx, range);
      expect(s.total).toBe(1_000);
      const c = await cashFlow(w.ctx, range);
      expect(c).toMatchObject({ inflow: 0, outflow: 1_000, net: -1_000 });
      const [m] = await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' });
      expect(m).toMatchObject({ income: 0, expense: 1_000 });
      const [sum] = await summariseMonth(w.ctx, range);
      expect(sum).toMatchObject({ income: 0, expense: 1_000, count: 1 });
    });
  });

  describe('purchase date', () => {
    it('counts a purchase in the month it happened, not the month the bank booked it', async () => {
      const w = await world();
      // A card statement books August purchases on 2 September.
      await w.add(w.main, '2026-09-02', -1_000, {
        categoryId: w.cats.groceries,
        transactionDate: '2026-08-20',
      });
      await w.add(w.main, '2026-08-31', -500, {
        categoryId: w.cats.dining,
        transactionDate: '2026-07-30',
      });

      expect((await spendingByGroup(w.ctx, range)).total).toBe(1_000);
      expect(await cashFlow(w.ctx, range)).toMatchObject({ outflow: 1_000 });
      const months = await monthlyTrends(w.ctx, { months: 3, endMonth: '2026-09' });
      expect(months.map((m) => m.expense)).toEqual([500, 1_000, 0]);
    });
  });

  describe('spendingByGroup', () => {
    it('groups expense outflows, nets refunds per category, clamps at zero, shares sum to 10000', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -3_000, { categoryId: w.cats.groceries });
      await w.add(w.main, '2026-08-03', 500, { categoryId: w.cats.groceries }); // refund
      await w.add(w.main, '2026-08-04', -2_000, { categoryId: w.cats.dining });
      await w.add(w.main, '2026-08-05', -90_000, { categoryId: w.cats.rent });
      await w.add(w.main, '2026-08-06', 4_000, { categoryId: w.cats.rent }); // refund
      await w.add(w.main, '2026-08-07', 900, { categoryId: w.cats.dining }); // refund > spend later
      await w.add(w.main, '2026-08-08', 5_000, { categoryId: w.cats.dining });
      await w.add(w.main, '2026-08-09', -1_234); // uncategorised
      await w.add(w.main, '2026-08-10', -999, { status: 'pending' });
      await w.add(w.main, '2026-09-01', -999, { categoryId: w.cats.rent });

      const s = await spendingByGroup(w.ctx, range);
      // groceries 2500, dining clamps to 0 (-2000 + 900 + 5000 > 0 refund), rent 86000
      expect(s.currency).toBe('EUR');
      expect(s.uncategorised).toBe(1_234);
      expect(s.total).toBe(2_500 + 86_000 + 1_234);
      expect(s.groups.map((g) => [g.name, g.amount])).toEqual([
        ['Home', 86_000],
        ['Food', 2_500],
      ]);
      expect(s.groups[1]!.categories).toEqual([
        { categoryId: w.cats.groceries, name: 'Groceries', amount: 2_500 },
      ]);
      // 9583.9 / 278.6 / 137.5: floors sum to 9998, the 2 left go to the largest remainders
      expect(s.groups.map((g) => g.share_bps)).toEqual([9_584, 279]);
      expect(s.groups.reduce((a, g) => a + g.share_bps, 0) + 137).toBe(10_000);
      expect(s.foreignCount).toBe(0);
    });

    it('uncategorised sums outflows only: inflows do not net against it', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', 2_000); // uncategorised income
      await w.add(w.main, '2026-08-03', -100); // uncategorised spending
      await w.add(w.main, '2026-08-04', -400, { categoryId: w.cats.groceries });
      const s = await spendingByGroup(w.ctx, range);
      expect(s.uncategorised).toBe(100);
      expect(s.total).toBe(500);
    });

    it('counts other-currency rows without summing them', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -1_000, { categoryId: w.cats.groceries });
      await w.add(w.main, '2026-08-03', -9_999, { categoryId: w.cats.groceries, currency: 'USD' });
      const s = await spendingByGroup(w.ctx, range);
      expect(s.total).toBe(1_000);
      expect(s.foreignCount).toBe(1);
    });

    it('is empty for an empty range and rejects bad input', async () => {
      const w = await world();
      expect(await spendingByGroup(w.ctx, range)).toEqual({
        currency: 'EUR',
        total: 0,
        groups: [],
        uncategorised: 0,
        foreignCount: 0,
      });
      await expect(spendingByGroup(w.ctx, { from: 'x', to: range.to })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        spendingByGroup(w.ctx, { from: '2026-09-01', to: '2026-08-01' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('never sees another household', async () => {
      const a = await world();
      const b = await world();
      await a.add(a.main, '2026-08-02', -1_000, { categoryId: a.cats.groceries });
      expect((await spendingByGroup(b.ctx, range)).total).toBe(0);
      expect((await cashFlow(b.ctx, range)).outflow).toBe(0);
    });
  });

  describe('monthlyTrends (Review Focus 5)', () => {
    it('zero-fills every month, including across a year boundary', async () => {
      const w = await world();
      await w.add(w.main, '2025-12-10', 200_000);
      await w.add(w.main, '2026-02-10', -3_000);
      const rows = await monthlyTrends(w.ctx, { months: 4, endMonth: '2026-03' });
      expect(rows.map((r) => r.month)).toEqual(['2025-12', '2026-01', '2026-02', '2026-03']);
      expect(rows[0]).toEqual({
        month: '2025-12',
        income: 200_000,
        expense: 0,
        saving: 0,
        net: 200_000,
      });
      expect(rows[1]).toEqual({ month: '2026-01', income: 0, expense: 0, saving: 0, net: 0 });
      expect(rows[2]).toEqual({
        month: '2026-02',
        income: 0,
        expense: 3_000,
        saving: 0,
        net: -3_000,
      });
      expect(rows[3]).toEqual({ month: '2026-03', income: 0, expense: 0, saving: 0, net: 0 });
    });

    it('saving is the net flow of all rows on accounts of saving lines, once per account', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      // two saving lines on one account must not double count; none on main
      await upsertBudgetLine(w.ctx, b.id, { kind: 'saving', name: 'A', accountId: w.sav });
      await upsertBudgetLine(w.ctx, b.id, { kind: 'saving', name: 'B', accountId: w.sav });
      await w.add(w.sav, '2026-08-03', 50_000, { transferGroupId: randomUUID() });
      await w.add(w.sav, '2026-08-05', -10_000, { categoryId: w.transferId }); // withdrawal
      await w.add(w.main, '2026-08-03', -50_000, { transferGroupId: randomUUID() });
      await w.add(w.sav, '2026-08-06', 700, { categoryId: w.cats.groceries }); // net of all rows
      await w.add(w.sav, '2026-08-06', -300, { categoryId: w.cats.groceries }); // card spending
      await w.add(w.sav, '2026-08-07', 100, { transferGroupId: randomUUID(), status: 'pending' });
      await w.add(w.sav, '2026-08-08', 100, {
        transferGroupId: randomUUID(),
        currency: 'USD',
      });
      await w.add(w.sav, '2027-02-03', 5_000, { transferGroupId: randomUUID() }); // outside budget year
      const rows = await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' });
      expect(rows[0]!.saving).toBe(40_400);
      const feb = await monthlyTrends(w.ctx, { months: 1, endMonth: '2027-02' });
      expect(feb[0]!.saving).toBe(0);
    });

    it('saving lines of archived budgets do not count', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await upsertBudgetLine(w.ctx, b.id, { kind: 'saving', name: 'A', accountId: w.sav });
      await w.add(w.sav, '2026-08-03', 50_000, { transferGroupId: randomUUID() });
      expect((await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' }))[0]!.saving).toBe(
        50_000,
      );
      await t.owner
        .update(schema.budget)
        .set({ status: 'archived' })
        .where(eq(schema.budget.id, b.id));
      expect((await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' }))[0]!.saving).toBe(0);
    });

    it('saving ignores the hub account and is 0 without a budget', async () => {
      const w = await world();
      await w.add(w.sav, '2026-08-03', 50_000, { transferGroupId: randomUUID() });
      expect((await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' }))[0]!.saving).toBe(0);
      await setHubAccount(w.ctx, w.sav);
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await upsertBudgetLine(w.ctx, b.id, { kind: 'saving', name: 'Hub pot', accountId: w.sav });
      expect((await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' }))[0]!.saving).toBe(0);
    });

    it('defaults endMonth to the current month in the household timezone', async () => {
      const w = await world('Pacific/Auckland'); // UTC+12/13
      // 2026-08-31 20:00Z is already 2026-09-01 in Auckland
      const now = new Date('2026-08-31T20:00:00Z');
      const rows = await monthlyTrends(w.ctx, { months: 2 }, now);
      expect(rows.map((r) => r.month)).toEqual(['2026-08', '2026-09']);
      const utc = await world('UTC');
      expect((await monthlyTrends(utc.ctx, { months: 1 }, now))[0]!.month).toBe('2026-08');
    });

    it('validates months and endMonth', async () => {
      const w = await world();
      for (const months of [0, 37, 1.5]) {
        await expect(monthlyTrends(w.ctx, { months })).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(monthlyTrends(w.ctx, { months: 2, endMonth: '2026-13' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('does not mix households', async () => {
      const a = await world();
      const b = await world();
      await a.add(a.main, '2026-08-02', -1_000);
      expect((await monthlyTrends(b.ctx, { months: 1, endMonth: '2026-08' }))[0]!.expense).toBe(0);
    });
  });

  describe('cashFlow', () => {
    it('sums household-currency inflow/outflow, per month (zero-filled) and per account', async () => {
      const w = await world();
      await w.add(w.main, '2026-07-15', 100_000);
      await w.add(w.main, '2026-08-02', -3_000, { categoryId: w.cats.groceries });
      await w.add(w.sav, '2026-08-03', 200);
      await w.add(w.main, '2026-08-04', -50_000, { transferGroupId: randomUUID() });
      await w.add(w.sav, '2026-08-04', 50_000, { transferGroupId: randomUUID() });
      await w.add(w.main, '2026-08-05', -9, { currency: 'USD' });
      await w.add(w.main, '2026-08-06', -1, { status: 'pending' });
      const c = await cashFlow(w.ctx, { from: '2026-06-15', to: '2026-08-31' });
      expect(c).toMatchObject({ inflow: 100_200, outflow: 3_000, net: 97_200, foreignCount: 1 });
      expect(c.byMonth).toEqual([
        { month: '2026-06', inflow: 0, outflow: 0, net: 0 },
        { month: '2026-07', inflow: 100_000, outflow: 0, net: 100_000 },
        { month: '2026-08', inflow: 200, outflow: 3_000, net: -2_800 },
      ]);
      expect([...c.byAccount].sort((x, y) => x.inflow - y.inflow)).toEqual(
        [
          { accountId: w.main, inflow: 100_000, outflow: 3_000 },
          { accountId: w.sav, inflow: 200, outflow: 0 },
        ].sort((x, y) => x.inflow - y.inflow),
      );
    });

    it('orders byAccount by outflow descending, then account name, then id', async () => {
      const w = await world();
      const alpha = (await createAccount(w.ctx, { name: 'Alpha', type: 'checking' })).id;
      await w.add(w.sav, '2026-08-02', -500); // Savings
      await w.add(alpha, '2026-08-02', -500); // Alpha, same outflow
      await w.add(w.main, '2026-08-02', -900); // Main, biggest
      const c = await cashFlow(w.ctx, range);
      expect(c.byAccount.map((a) => a.accountId)).toEqual([w.main, alpha, w.sav]);
    });

    it('a month with only transfers is zero, and accountIds narrows the result', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-04', -50_000, { transferGroupId: randomUUID() });
      await w.add(w.sav, '2026-08-04', 50_000, { categoryId: w.transferId });
      expect(await cashFlow(w.ctx, range)).toMatchObject({ inflow: 0, outflow: 0, net: 0 });
      await w.add(w.main, '2026-08-05', -300);
      await w.add(w.sav, '2026-08-05', 700);
      const only = await cashFlow(w.ctx, { ...range, accountIds: [w.sav] });
      expect(only).toMatchObject({ inflow: 700, outflow: 0, net: 700 });
      expect(only.byAccount).toEqual([{ accountId: w.sav, inflow: 700, outflow: 0 }]);
      await expect(cashFlow(w.ctx, { ...range, accountIds: ['nope'] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('one monthly expense/income definition', () => {
    // expense = net outflow of expense-kind categories (refunds net out) + uncategorised booked
    // outflows; income = income-kind net + uncategorised booked inflows; saving-kind categories
    // and transfers are neither. summariseMonth, monthlyTrends and spendingByGroup agree.
    async function mixed() {
      const w = await world();
      const gInc = await createCategoryGroup(w.ctx, { name: 'Pay', kind: 'income' });
      const gSav = await createCategoryGroup(w.ctx, { name: 'Save', kind: 'saving' });
      const salary = (await createCategory(w.ctx, { groupId: gInc.id, name: 'Salary' })).id;
      const pot = (await createCategory(w.ctx, { groupId: gSav.id, name: 'Pot' })).id;
      await w.add(w.main, '2026-08-01', 300_000, { categoryId: salary });
      await w.add(w.main, '2026-08-02', -3_000, { categoryId: w.cats.groceries });
      await w.add(w.main, '2026-08-03', 1_000, { categoryId: w.cats.groceries }); // refund
      await w.add(w.main, '2026-08-04', -20_000, { categoryId: pot }); // saving-kind outflow
      await w.add(w.main, '2026-08-05', 5_000, { categoryId: pot }); // saving-kind inflow
      await w.add(w.main, '2026-08-06', -700); // uncategorised outflow
      await w.add(w.main, '2026-08-07', 400); // uncategorised inflow
      return w;
    }

    it('summariseMonth nets refunds and leaves saving-kind categories out of both', async () => {
      const w = await mixed();
      const [sum] = await summariseMonth(w.ctx, range);
      expect(sum).toMatchObject({ income: 300_000 + 400, expense: 2_000 + 700 });
    });

    it('monthlyTrends gives the same numbers as summariseMonth', async () => {
      const w = await mixed();
      const [m] = await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' });
      expect(m).toMatchObject({ income: 300_400, expense: 2_700, net: 297_700 });
    });

    it('the expense total equals the spendingByGroup total', async () => {
      const w = await mixed();
      const [m] = await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' });
      expect(m!.expense).toBe((await spendingByGroup(w.ctx, range)).total);
    });

    it('a refund larger than the spend clamps the category at zero, as in spendingByGroup', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -1_000, { categoryId: w.cats.dining });
      await w.add(w.main, '2026-08-03', 4_000, { categoryId: w.cats.dining });
      const [m] = await monthlyTrends(w.ctx, { months: 1, endMonth: '2026-08' });
      expect(m).toMatchObject({ income: 0, expense: 0 });
      const [sum] = await summariseMonth(w.ctx, range);
      expect(sum).toMatchObject({ income: 0, expense: 0 });
    });
  });

  describe('summariseMonth transfer rule', () => {
    it('still excludes rows with a transfer group and pending rows', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -100);
      await w.add(w.main, '2026-08-03', -200, { transferGroupId: randomUUID() });
      await w.add(w.main, '2026-08-04', -300, { status: 'pending' });
      const [sum] = await summariseMonth(w.ctx, range);
      expect(sum).toMatchObject({ expense: 100, count: 1 });
    });
  });

  describe('roles', () => {
    it('viewers can read every analytics function', async () => {
      const w = await world();
      await w.add(w.main, '2026-08-02', -1_000, { categoryId: w.cats.groceries });
      const viewer = withRole(w.ctx, 'viewer');
      expect((await spendingByGroup(viewer, range)).total).toBe(1_000);
      expect((await monthlyTrends(viewer, { months: 1, endMonth: '2026-08' }))[0]!.expense).toBe(
        1_000,
      );
      expect((await cashFlow(viewer, range)).outflow).toBe(1_000);
    });
  });
});
