import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import { computeLineActual, type ActualRow } from '@arfolio/core';
import {
  budgetMonthView,
  budgetYearView,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  deleteBudgetLine,
  archiveBudget,
  ForbiddenError,
  getBudget,
  addCategoryToLine,
  linkCategories,
  listBudgets,
  NotFoundError,
  renameBudget,
  saveBudgetLine,
  setBudgetAlertThresholds,
  updateBudgetSettings,
  getBudgetLine,
  setFiscalYearStartMonth,
  setHubAccount,
  setLineAmounts,
  transferPlan,
  unarchiveBudget,
  unbudgetedSpending,
  upsertBudgetLine,
  ValidationError,
} from '../src/index.js';
import { budgetActualsQuery, ensureTransferCategory } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { transaction, householdSettings, investmentBucket, investmentBucketSnapshot } = schema;
const flat = (n: number): number[] => Array.from({ length: 12 }, () => n);

describe('budgets service', () => {
  let t: ServicesTestDb;
  let hashN = 0;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** A household with three accounts, a category tree and the transfer category. */
  async function world(opts: { fiscalStart?: number; timezone?: string } = {}) {
    const ctx = await t.household({ currency: 'EUR' });
    await t.owner
      .update(householdSettings)
      .set({
        timezone: opts.timezone ?? 'Europe/Lisbon',
        fiscalYearStartMonth: opts.fiscalStart ?? 1,
      })
      .where(eq(householdSettings.householdId, ctx.householdId));
    const hub = await createAccount(ctx, { name: 'Hub', type: 'checking' });
    const card = await createAccount(ctx, { name: 'Card', type: 'card' });
    const sav = await createAccount(ctx, { name: 'Savings', type: 'savings' });
    const gIncome = await createCategoryGroup(ctx, { name: 'Income', kind: 'income' });
    const gHome = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
    const gSaving = await createCategoryGroup(ctx, { name: 'Saving', kind: 'saving' });
    const cat = async (groupId: string, name: string) =>
      (await createCategory(ctx, { groupId, name })).id;
    const salary = await cat(gIncome.id, 'Salary');
    const rent = await cat(gHome.id, 'Rent');
    const food = await cat(gHome.id, 'Food');
    const fuel = await cat(gHome.id, 'Fuel');
    const invest = await cat(gSaving.id, 'Invest');
    const transferCat = await withHousehold(ctx.db, ctx.householdId, (tx) =>
      ensureTransferCategory(tx, ctx.householdId),
    );

    const row = (over: Partial<typeof transaction.$inferInsert> & { amount: number }) => ({
      householdId: ctx.householdId,
      accountId: hub.id,
      dedupeHash: `b${(hashN += 1)}`,
      bookingDate: '2026-01-15',
      currency: 'EUR',
      status: 'booked' as const,
      rawDescription: 'x',
      source: 'manual' as const,
      ...over,
    });
    const addTx = async (
      rows: Array<Partial<typeof transaction.$inferInsert> & { amount: number }>,
    ) => {
      const inserted = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.insert(transaction).values(rows.map(row)).returning({ id: transaction.id }),
      );
      return inserted.map((r) => r.id);
    };
    return {
      ctx,
      hub,
      card,
      sav,
      groups: { income: gIncome.id, home: gHome.id, saving: gSaving.id },
      cats: { salary, rent, food, fuel, invest, transfer: transferCat },
      addTx,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** Budget for calendar 2026 with income/expense/saving lines like the spreadsheet example. */
  async function sheetBudget(w: World, startMonth = '2026-01-01') {
    const b = await createBudget(w.ctx, { startMonth });
    const line = async (
      kind: 'income' | 'expense' | 'saving',
      name: string,
      planned: number,
      cats: string[],
      extra: { groupId?: string; accountId?: string } = {},
    ) => {
      const l = await upsertBudgetLine(w.ctx, b.id, { kind, name, ...extra });
      await setLineAmounts(w.ctx, l.id, flat(planned));
      await linkCategories(w.ctx, l.id, cats);
      return l;
    };
    const salary = await line('income', 'Salary', 300_000, [w.cats.salary], {
      groupId: w.groups.income,
      accountId: w.hub.id,
    });
    const rent = await line('expense', 'Rent', 90_000, [w.cats.rent], { groupId: w.groups.home });
    const food = await line('expense', 'Food', 40_000, [w.cats.food], {
      groupId: w.groups.home,
      accountId: w.card.id,
    });
    const fuel = await line('expense', 'Fuel', 15_000, [w.cats.fuel], { groupId: w.groups.home });
    const emergency = await line('saving', 'Emergency fund', 50_000, [w.cats.invest], {
      groupId: w.groups.saving,
      accountId: w.sav.id,
    });
    return { b, salary, rent, food, fuel, emergency };
  }

  describe('budgets, lines, amounts and links', () => {
    it('creates a budget with a default name and rejects a second one for the same start', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      expect(b).toMatchObject({ startMonth: '2026-01-01', status: 'active', name: '2026' });
      const b2 = await createBudget(w.ctx, { startMonth: '2026-10-01', name: 'Custom' });
      expect(b2.name).toBe('Custom');
      await expect(createBudget(w.ctx, { startMonth: '2026-01-01' })).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'budget_exists',
      });
      expect((await listBudgets(w.ctx)).map((x) => x.startMonth)).toEqual([
        '2026-10-01',
        '2026-01-01',
      ]);
    });

    it('names a budget that spans two calendar years after both', async () => {
      const w = await world();
      expect((await createBudget(w.ctx, { startMonth: '2026-10-01' })).name).toBe('2026/27');
    });

    it('rejects a start that is not the first of a month', async () => {
      const w = await world();
      await expect(createBudget(w.ctx, { startMonth: '2026-01-02' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createBudget(w.ctx, { startMonth: '2026-02-30' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('upserts a line by (kind, name), keeps one row, and stores 12 amounts', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l1 = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'Rent' });
      const l2 = await upsertBudgetLine(w.ctx, b.id, {
        kind: 'expense',
        name: 'Rent',
        notes: 'n',
        groupId: w.groups.home,
      });
      expect(l2.id).toBe(l1.id);
      const amounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => n * 100);
      await setLineAmounts(w.ctx, l1.id, amounts);
      const got = await getBudget(w.ctx, b.id);
      expect(got.lines).toHaveLength(1);
      expect(got.lines[0]).toMatchObject({
        name: 'Rent',
        notes: 'n',
        groupId: w.groups.home,
        amounts,
        categoryIds: [],
      });
    });

    it('rejects amounts that are not 12 non-negative safe integers', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'Rent' });
      for (const bad of [
        flat(1).slice(0, 11),
        [...flat(1), 1],
        [...flat(1).slice(1), -1],
        [...flat(1).slice(1), 1.5],
      ]) {
        await expect(setLineAmounts(w.ctx, l.id, bad)).rejects.toBeInstanceOf(ValidationError);
      }
    });

    it('caps a planned amount at 1e12 minor units', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'Rent' });
      await setLineAmounts(w.ctx, l.id, [...flat(1).slice(1), 1e12]);
      await expect(
        setLineAmounts(w.ctx, l.id, [...flat(1).slice(1), 1e12 + 1]),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('links categories with replace semantics and rejects clashes inside a budget', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const a = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
      const c = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'C' });
      await linkCategories(w.ctx, a.id, [w.cats.rent, w.cats.food]);
      await expect(linkCategories(w.ctx, c.id, [w.cats.food])).rejects.toMatchObject({
        name: 'ConflictError',
        code: 'category_already_linked',
      });
      // Re-linking its own category is fine, and the list replaces the previous links.
      await linkCategories(w.ctx, a.id, [w.cats.food]);
      await linkCategories(w.ctx, c.id, [w.cats.rent]);
      const got = await getBudget(w.ctx, b.id);
      expect(got.lines.find((l) => l.name === 'A')?.categoryIds).toEqual([w.cats.food]);
      expect(got.lines.find((l) => l.name === 'C')?.categoryIds).toEqual([w.cats.rent]);
    });

    it('addCategoryToLine appends in one transaction, idempotently, and keeps the other links', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const a = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
      const c = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'C' });
      await linkCategories(w.ctx, a.id, [w.cats.rent]);
      await addCategoryToLine(w.ctx, a.id, w.cats.food);
      await addCategoryToLine(w.ctx, a.id, w.cats.food);
      const got = await getBudget(w.ctx, b.id);
      expect(got.lines.find((l) => l.name === 'A')?.categoryIds.sort()).toEqual(
        [w.cats.rent, w.cats.food].sort(),
      );
      await expect(addCategoryToLine(w.ctx, c.id, w.cats.food)).rejects.toMatchObject({
        name: 'ConflictError',
        code: 'category_already_linked',
      });
      await expect(addCategoryToLine(w.ctx, a.id, w.cats.transfer)).rejects.toMatchObject({
        code: 'transfer_category',
      });
      await expect(addCategoryToLine(w.ctx, a.id, randomUUID())).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('addCategoryToLine is writer-only', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const a = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
      await expect(
        addCategoryToLine(withRole(w.ctx, 'viewer'), a.id, w.cats.food),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects the transfer category and unknown categories', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
      await expect(linkCategories(w.ctx, l.id, [w.cats.transfer])).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'transfer_category',
      });
      await expect(linkCategories(w.ctx, l.id, [randomUUID()])).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('deletes a line with its amounts and links', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await deleteBudgetLine(w.ctx, s.rent.id);
      const got = await getBudget(w.ctx, s.b.id);
      expect(got.lines.map((l) => l.name)).not.toContain('Rent');
      // The category is free again.
      const l = await upsertBudgetLine(w.ctx, s.b.id, { kind: 'expense', name: 'Rent 2' });
      await linkCategories(w.ctx, l.id, [w.cats.rent]);
      await expect(deleteBudgetLine(w.ctx, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('copies lines, links and amounts when copying from another budget', async () => {
      const w = await world();
      const s = await sheetBudget(w, '2026-01-01');
      const copy = await createBudget(w.ctx, {
        startMonth: '2027-01-01',
        copyFromBudgetId: s.b.id,
      });
      const src = await getBudget(w.ctx, s.b.id);
      const dst = await getBudget(w.ctx, copy.id);
      const shape = (g: typeof src) =>
        g.lines.map((l) => ({
          kind: l.kind,
          name: l.name,
          groupId: l.groupId,
          accountId: l.accountId,
          position: l.position,
          amounts: l.amounts,
          categoryIds: [...l.categoryIds].sort(),
        }));
      expect(shape(dst)).toEqual(shape(src));
      expect(dst.lines.map((l) => l.id).some((id) => src.lines.some((x) => x.id === id))).toBe(
        false,
      );
      // The copy is independent.
      await setLineAmounts(w.ctx, dst.lines[0]!.id, flat(1));
      expect((await getBudget(w.ctx, s.b.id)).lines[0]!.amounts).toEqual(src.lines[0]!.amounts);
    });

    it('is household-isolated: another household cannot read, copy or edit', async () => {
      const w = await world();
      const other = await t.household();
      const s = await sheetBudget(w);
      await expect(getBudget(other, s.b.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createBudget(other, { startMonth: '2027-01-01', copyFromBudgetId: s.b.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(setLineAmounts(other, s.rent.id, flat(1))).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        upsertBudgetLine(other, s.b.id, { kind: 'expense', name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await listBudgets(other)).toEqual([]);
    });

    it('viewers can read but not write', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const v = withRole(w.ctx, 'viewer');
      await expect(getBudget(v, s.b.id)).resolves.toBeDefined();
      await expect(budgetMonthView(v, s.b.id, 1)).resolves.toBeDefined();
      await expect(listBudgets(v)).resolves.toHaveLength(1);
      await expect(createBudget(v, { startMonth: '2027-01-01' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        upsertBudgetLine(v, s.b.id, { kind: 'expense', name: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteBudgetLine(v, s.rent.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setLineAmounts(v, s.rent.id, flat(1))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(linkCategories(v, s.rent.id, [])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setHubAccount(v, null)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('month view', () => {
    it('matches the spreadsheet example: planned, actual, remaining, percent, unallocated', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: 300_000, categoryId: w.cats.salary }, // income 3000.00
        { amount: -90_000, categoryId: w.cats.rent },
        { amount: -25_000, categoryId: w.cats.food },
        { amount: -10_000, categoryId: w.cats.food, bookingDate: '2026-01-31' },
        { amount: -50_000, categoryId: w.cats.invest }, // saving category outflow
        { amount: -99_999, categoryId: w.cats.rent, bookingDate: '2026-02-01' }, // other month
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v).toMatchObject({
        monthIndex: 1,
        from: '2026-01-01',
        to: '2026-01-31',
        currency: 'EUR',
      });
      const by = (name: string) => v.lines.find((l) => l.name === name)!;
      expect(by('Salary')).toMatchObject({
        planned: 300_000,
        actual: 300_000,
        remaining: 0,
        percent: 100,
      });
      expect(by('Rent')).toMatchObject({
        planned: 90_000,
        actual: 90_000,
        remaining: 0,
        percent: 100,
      });
      expect(by('Food')).toMatchObject({
        planned: 40_000,
        actual: 35_000,
        remaining: 5_000,
        percent: 88,
      });
      expect(by('Fuel')).toMatchObject({
        planned: 15_000,
        actual: 0,
        remaining: 15_000,
        percent: 0,
      });
      expect(by('Emergency fund')).toMatchObject({ planned: 50_000, actual: 50_000 });
      expect(v.totals.income).toEqual({ planned: 300_000, actual: 300_000, pending: 0 });
      expect(v.totals.expense).toEqual({ planned: 145_000, actual: 125_000, pending: 0 });
      expect(v.totals.saving).toEqual({ planned: 50_000, actual: 50_000, pending: 0 });
      // unallocated = income - expense - saving
      expect(v.unallocated).toEqual({
        planned: 300_000 - 145_000 - 50_000,
        actual: 300_000 - 125_000 - 50_000,
      });
      expect(v.unallocated.planned).toBe(105_000);
      const home = v.groups.find((g) => g.kind === 'expense' && g.groupId === w.groups.home);
      expect(home).toMatchObject({ planned: 145_000, actual: 125_000 });
    });

    it('has a null percent when nothing is planned and counts months without amounts as 0', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'Misc' });
      await linkCategories(w.ctx, l.id, [w.cats.fuel]);
      await w.addTx([{ amount: -1_000, categoryId: w.cats.fuel }]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.lines[0]).toMatchObject({
        planned: 0,
        actual: 1_000,
        remaining: -1_000,
        percent: null,
      });
    });

    it('validates the month index and the budget id', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      for (const bad of [0, 13, 1.5]) {
        await expect(budgetMonthView(w.ctx, s.b.id, bad)).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(budgetMonthView(w.ctx, randomUUID(), 1)).rejects.toBeInstanceOf(NotFoundError);
      await expect(budgetMonthView(w.ctx, 'nope', 1)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('shows pending rows separately and never adds them to actual', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: -10_000, categoryId: w.cats.food },
        { amount: -4_000, categoryId: w.cats.food, status: 'pending' },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Food')).toMatchObject({
        actual: 10_000,
        pending: 4_000,
        remaining: 30_000,
      });
      expect(v.totals.expense).toMatchObject({ actual: 10_000, pending: 4_000 });
    });

    it('sums only household-currency rows and counts the others per line', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: -10_000, categoryId: w.cats.food },
        { amount: -77_700, categoryId: w.cats.food, currency: 'USD' },
        { amount: -1_000, categoryId: w.cats.food, currency: 'GBP', status: 'pending' },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Food')).toMatchObject({
        actual: 10_000,
        pending: 0,
        foreignCurrencyRows: 2,
      });
    });

    it('ignores other households data even with identical categories ids elsewhere', async () => {
      const w = await world();
      const o = await world();
      const s = await sheetBudget(w);
      await o.addTx([{ amount: -99_000, categoryId: o.cats.food }]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.totals.expense.actual).toBe(0);
    });
  });

  describe('Review Focus 1: transfers are not income or expense', () => {
    it('a transfer between two household accounts does not touch expense or income lines', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const group = randomUUID();
      await w.addTx([
        // Out of the hub, into the card; the card leg even carries a linked category by mistake.
        {
          amount: -20_000,
          accountId: w.hub.id,
          transferGroupId: group,
          categoryId: w.cats.transfer,
        },
        { amount: 20_000, accountId: w.card.id, transferGroupId: group, categoryId: w.cats.salary },
        // A transfer-category row whose group was lost: still not an expense.
        { amount: -5_000, categoryId: w.cats.transfer },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.totals.income.actual).toBe(0);
      expect(v.totals.expense.actual).toBe(0);
      expect(v.lines.every((l) => l.kind === 'saving' || l.actual === 0)).toBe(true);
      expect(await unbudgetedSpending(w.ctx, s.b.id, 1)).toEqual([]);
    });

    it('saving actual counts the inflow leg and plain rows on the account, never the outflow leg', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const group = randomUUID();
      await w.addTx([
        {
          amount: -50_000,
          accountId: w.hub.id,
          transferGroupId: group,
          categoryId: w.cats.transfer,
        },
        {
          amount: 50_000,
          accountId: w.sav.id,
          transferGroupId: group,
          categoryId: w.cats.transfer,
        },
        // an inflow into some other account is not this line's saving
        { amount: 12_345, accountId: w.card.id, transferGroupId: randomUUID() },
        // a plain deposit on the savings account counts too: the whole account is the line
        { amount: 7_000, accountId: w.sav.id },
        // a pending inflow is pending, not actual
        { amount: 1_000, accountId: w.sav.id, transferGroupId: randomUUID(), status: 'pending' },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Emergency fund')).toMatchObject({
        actual: 57_000,
        pending: 1_000,
      });
      expect(v.totals.saving.actual).toBe(57_000);
      expect(v.unallocated.actual).toBe(0 - 0 - 57_000);
    });

    it('saving combines transfer inflows with linked saving categories', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: 30_000, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: -2_000, categoryId: w.cats.invest },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Emergency fund')!.actual).toBe(32_000);
    });
  });

  describe('Review Focus 2: refunds and recategorisation', () => {
    it('a refund reduces the expense actual and may take it below zero', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: -10_000, categoryId: w.cats.food },
        { amount: 3_000, categoryId: w.cats.food },
        { amount: 800, categoryId: w.cats.fuel },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Food')!.actual).toBe(7_000);
      const fuel = v.lines.find((l) => l.name === 'Fuel')!;
      expect(fuel.actual).toBe(-800);
      expect(fuel.remaining).toBe(15_800);
    });

    it('recomputes when a transaction is categorised later (AI, rule or user)', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const [id] = await w.addTx([{ amount: -6_000 }]); // uncategorised
      let v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.totals.expense.actual).toBe(0);
      expect(await unbudgetedSpending(w.ctx, s.b.id, 1)).toEqual([
        expect.objectContaining({ categoryId: null, actual: 6_000 }),
      ]);
      await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
        tx
          .update(transaction)
          .set({ categoryId: w.cats.food, categorisedBy: 'ai' })
          .where(eq(transaction.id, id!)),
      );
      v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Food')!.actual).toBe(6_000);
      expect(await unbudgetedSpending(w.ctx, s.b.id, 1)).toEqual([]);
    });
  });

  describe('Review Focus 3: fiscal year in October, household calendar months', () => {
    it('month 1 is October of the start year and 30 Sep belongs to the previous budget', async () => {
      const w = await world({ fiscalStart: 10 });
      const cur = await sheetBudget(w, '2026-10-01');
      const prevB = await createBudget(w.ctx, { startMonth: '2025-10-01' });
      const prevLine = await upsertBudgetLine(w.ctx, prevB.id, { kind: 'expense', name: 'Food' });
      await linkCategories(w.ctx, prevLine.id, [w.cats.food]);
      await setLineAmounts(w.ctx, prevLine.id, flat(100_000));
      await w.addTx([
        { amount: -1_000, categoryId: w.cats.food, bookingDate: '2026-09-30' },
        { amount: -2_000, categoryId: w.cats.food, bookingDate: '2026-10-01' },
        { amount: -3_000, categoryId: w.cats.food, bookingDate: '2026-12-31' },
        { amount: -4_000, categoryId: w.cats.food, bookingDate: '2027-01-01' },
        { amount: -5_000, categoryId: w.cats.food, bookingDate: '2027-09-30' },
        { amount: -6_000, categoryId: w.cats.food, bookingDate: '2027-10-01' },
      ]);
      const food = (g: Awaited<ReturnType<typeof budgetYearView>>) =>
        g.lines.find((l) => l.name === 'Food')!;
      const y = await budgetYearView(w.ctx, cur.b.id);
      expect(y.months[0]).toEqual({ index: 1, from: '2026-10-01', to: '2026-10-31' });
      expect(food(y).months.map((m) => m.actual)).toEqual([
        2_000, 0, 3_000, 4_000, 0, 0, 0, 0, 0, 0, 0, 5_000,
      ]);
      expect(food(y).total.actual).toBe(14_000); // 30 Sep and 1 Oct 2027 are outside this budget
      const prev = await budgetYearView(w.ctx, prevB.id);
      expect(food(prev).months[11]!.actual).toBe(1_000); // 30 Sep 2026 = month 12 of the 2025 budget
      expect(food(prev).total.actual).toBe(1_000);
    });

    it('a card purchase counts in the month it was made, not the month the statement booked it', async () => {
      const w = await world();
      const cur = await sheetBudget(w);
      const gUnb = await createCategoryGroup(w.ctx, { name: 'Other', kind: 'expense' });
      const misc = (await createCategory(w.ctx, { groupId: gUnb.id, name: 'Misc' })).id;
      await w.addTx([
        {
          amount: -1_000,
          categoryId: w.cats.food,
          accountId: w.card.id,
          bookingDate: '2026-03-02',
          transactionDate: '2026-02-20',
        },
        {
          amount: -700,
          categoryId: misc,
          accountId: w.card.id,
          bookingDate: '2026-03-02',
          transactionDate: '2026-02-21',
        },
      ]);
      const y = await budgetYearView(w.ctx, cur.b.id);
      const food = y.lines.find((l) => l.name === 'Food')!;
      expect(food.months.slice(1, 3).map((m) => m.actual)).toEqual([1_000, 0]);
      expect((await unbudgetedSpending(w.ctx, cur.b.id, 2)).map((r) => r.actual)).toEqual([700]);
      expect(await unbudgetedSpending(w.ctx, cur.b.id, 3)).toEqual([]);
    });

    it('month boundaries are inclusive and unaffected by DST changes', async () => {
      const w = await world({ timezone: 'Europe/Lisbon' });
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: -100, categoryId: w.cats.food, bookingDate: '2026-03-28' },
        { amount: -200, categoryId: w.cats.food, bookingDate: '2026-03-29' }, // clocks go forward
        { amount: -400, categoryId: w.cats.food, bookingDate: '2026-03-31' },
        { amount: -800, categoryId: w.cats.food, bookingDate: '2026-04-01' },
        { amount: -1_600, categoryId: w.cats.food, bookingDate: '2026-10-25' }, // clocks go back
        { amount: -3_200, categoryId: w.cats.food, bookingDate: '2026-10-31' },
        { amount: -6_400, categoryId: w.cats.food, bookingDate: '2026-11-01' },
      ]);
      const month = async (i: number) =>
        (await budgetMonthView(w.ctx, s.b.id, i)).lines.find((l) => l.name === 'Food')!.actual;
      expect(await month(3)).toBe(700);
      expect(await month(4)).toBe(800);
      expect(await month(10)).toBe(4_800);
      expect(await month(11)).toBe(6_400);
    });

    it('rejects an unknown household timezone with a ValidationError', async () => {
      const w = await world({ timezone: 'Mars/Olympus' });
      const s = await sheetBudget(w);
      for (const call of [
        () => budgetMonthView(w.ctx, s.b.id, 1),
        () => budgetYearView(w.ctx, s.b.id),
        () => unbudgetedSpending(w.ctx, s.b.id, 1),
      ]) {
        await expect(call()).rejects.toMatchObject({
          name: 'ValidationError',
          code: 'invalid_timezone',
        });
      }
    });
  });

  describe('year view', () => {
    it('returns a 12 x lines grid with line, kind and unallocated totals', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: 300_000, categoryId: w.cats.salary, bookingDate: '2026-01-25' },
        { amount: 300_000, categoryId: w.cats.salary, bookingDate: '2026-02-25' },
        { amount: -40_000, categoryId: w.cats.rent, bookingDate: '2026-02-03' },
        { amount: -9_000, categoryId: w.cats.rent, bookingDate: '2026-02-04', status: 'pending' },
        { amount: -1_000, categoryId: w.cats.rent, bookingDate: '2025-12-31' }, // before the year
        { amount: -1_000, categoryId: w.cats.rent, bookingDate: '2027-01-01' }, // after the year
      ]);
      const y = await budgetYearView(w.ctx, s.b.id);
      expect(y.months).toHaveLength(12);
      expect(y.lines).toHaveLength(5);
      for (const l of y.lines) expect(l.months).toHaveLength(12);
      const rent = y.lines.find((l) => l.name === 'Rent')!;
      expect(rent.months[1]).toEqual({
        index: 2,
        noData: false,
        planned: 90_000,
        actual: 40_000,
        pending: 9_000,
      });
      expect(rent.total).toEqual({ planned: 1_080_000, actual: 40_000, pending: 9_000 });
      expect(y.totals.income.total).toEqual({ planned: 3_600_000, actual: 600_000, pending: 0 });
      expect(y.totals.income.months[0]).toEqual({
        index: 1,
        noData: false,
        planned: 300_000,
        actual: 300_000,
        pending: 0,
      });
      expect(y.totals.expense.months[1]).toMatchObject({
        planned: 145_000,
        actual: 40_000,
        pending: 9_000,
      });
      expect(y.unallocated.months[1]).toEqual({
        index: 2,
        planned: 300_000 - 145_000 - 50_000,
        actual: 300_000 - 40_000 - 0,
      });
      expect(y.unallocated.planned).toBe(12 * 105_000);
      expect(y.unallocated.actual).toBe(600_000 - 40_000);
    });

    it('agrees with the month view for every month', async () => {
      const w = await world({ fiscalStart: 10 });
      const s = await sheetBudget(w, '2026-10-01');
      const group = randomUUID();
      await w.addTx([
        { amount: -11_100, categoryId: w.cats.food, bookingDate: '2026-11-11' },
        { amount: 2_200, categoryId: w.cats.food, bookingDate: '2027-02-02' },
        { amount: 40_000, accountId: w.sav.id, transferGroupId: group, bookingDate: '2027-05-05' },
        { amount: 300_000, categoryId: w.cats.salary, bookingDate: '2027-09-30' },
      ]);
      const y = await budgetYearView(w.ctx, s.b.id);
      for (let i = 1; i <= 12; i++) {
        const m = await budgetMonthView(w.ctx, s.b.id, i);
        for (const l of m.lines) {
          const cell = y.lines.find((x) => x.lineId === l.lineId)!.months[i - 1]!;
          expect(cell).toEqual({
            index: i,
            noData: l.noData,
            planned: l.planned,
            actual: l.actual,
            pending: l.pending,
          });
        }
        expect(y.unallocated.months[i - 1]).toEqual({ index: i, ...m.unallocated });
      }
    });
  });

  describe('SQL aggregate parity with the core reference', () => {
    it('matches computeLineActual on a mixed dataset', async () => {
      const w = await world();
      await setHubAccount(w.ctx, w.hub.id);
      const s = await sheetBudget(w);
      const hubPotCat = (await createCategory(w.ctx, { groupId: w.groups.saving, name: 'Pot' })).id;
      const hubPot = await upsertBudgetLine(w.ctx, s.b.id, {
        kind: 'saving',
        name: 'Hub pot',
        accountId: w.hub.id,
      });
      await setLineAmounts(w.ctx, hubPot.id, flat(10_000));
      await linkCategories(w.ctx, hubPot.id, [hubPotCat]);
      const tg = () => randomUUID();
      const rows = [
        { amount: -800, categoryId: hubPotCat },
        { amount: -1_234, categoryId: w.cats.food },
        { amount: 500, categoryId: w.cats.food },
        { amount: -300, categoryId: w.cats.food, status: 'pending' as const },
        { amount: -9_000, categoryId: w.cats.food, currency: 'USD' },
        { amount: 20_000, accountId: w.sav.id, transferGroupId: tg() },
        { amount: -20_000, accountId: w.hub.id, transferGroupId: tg() },
        { amount: 600, accountId: w.sav.id, transferGroupId: tg(), status: 'pending' as const },
        { amount: 5_500, accountId: w.sav.id, transferGroupId: tg(), currency: 'USD' },
        { amount: -700, categoryId: w.cats.invest },
        { amount: -450, accountId: w.sav.id, categoryId: w.cats.invest }, // line's own account
        { amount: 100_000, categoryId: w.cats.salary },
        { amount: -50, categoryId: w.cats.salary },
        // withdrawal leg out of the savings account, and a transfer whose group was lost
        { amount: -4_000, accountId: w.sav.id, transferGroupId: tg() },
        { amount: 900, accountId: w.sav.id, categoryId: w.cats.transfer },
        {
          amount: -250,
          accountId: w.sav.id,
          categoryId: w.cats.transfer,
          status: 'pending' as const,
        },
        { amount: -33, categoryId: w.cats.transfer },
      ];
      await w.addTx(rows);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      const asActual = (r: (typeof rows)[number]): ActualRow => ({
        amount: r.amount,
        isTransfer:
          'transferGroupId' in r || ('categoryId' in r && r.categoryId === w.cats.transfer),
        status: r.status ?? 'booked',
        currency: r.currency ?? 'EUR',
        categoryLinked: false, // set per line below
        accountId: ('accountId' in r ? r.accountId : w.hub.id) as string,
      });
      const linesByCat: Record<string, string[]> = {
        Salary: [w.cats.salary],
        Rent: [w.cats.rent],
        Food: [w.cats.food],
        Fuel: [w.cats.fuel],
        'Emergency fund': [w.cats.invest],
        'Hub pot': [hubPotCat],
      };
      // How the services classify each saving line: the sole whole-account line on its account
      // reads the account ('account'); 'Hub pot' is on the hub, which never receives account flow.
      const sourceOf = (name: string) => (name === 'Emergency fund' ? 'account' : 'categories');
      for (const l of v.lines) {
        const kind = l.kind;
        const accountId = l.accountId;
        const expected = computeLineActual(
          kind,
          rows.map((r) => ({
            ...asActual(r),
            categoryLinked:
              'categoryId' in r &&
              linesByCat[l.name]!.includes((r as { categoryId: string }).categoryId),
          })),
          { currency: 'EUR', accountId, hubAccountId: w.hub.id, source: sourceOf(l.name) },
        );
        expect({ actual: l.actual, pending: l.pending, foreign: l.foreignCurrencyRows }).toEqual({
          actual: expected.actual,
          pending: expected.pending,
          foreign: expected.foreignCurrencyRows,
        });
      }
    });
  });

  describe('largestRow (lump-sum detection)', () => {
    it('is the largest single booked outflow of the line in the month, household currency only', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: -3_000, categoryId: w.cats.food },
        { amount: -12_000, categoryId: w.cats.food },
        { amount: -90_000, categoryId: w.cats.food, status: 'pending' as const },
        { amount: -50_000, categoryId: w.cats.food, currency: 'USD' },
        { amount: 70_000, categoryId: w.cats.food }, // a refund is not an outflow
        { amount: -85_000, categoryId: w.cats.rent },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Food')!.largestRow).toBe(12_000);
      expect(v.lines.find((l) => l.name === 'Rent')!.largestRow).toBe(85_000);
      expect(v.lines.find((l) => l.name === 'Fuel')!.largestRow).toBe(0);
    });
  });

  describe('saving as net transfer flow and shared accounts', () => {
    it('a withdrawal reduces saving and may take it negative', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: 10_000, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: -25_000, accountId: w.sav.id, transferGroupId: randomUUID() },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Emergency fund')!.actual).toBe(-15_000);
      expect(v.totals.saving.actual).toBe(-15_000);
    });

    it('a saving line on the hub only counts its linked categories, never the hub transfer flow', async () => {
      const w = await world();
      await setHubAccount(w.ctx, w.hub.id);
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, {
        kind: 'saving',
        name: 'Main account pot',
        accountId: w.hub.id,
      });
      await setLineAmounts(w.ctx, l.id, flat(10_000));
      await linkCategories(w.ctx, l.id, [w.cats.invest]);
      await w.addTx([
        { amount: -20_000, accountId: w.hub.id, transferGroupId: randomUUID() },
        { amount: 5_000, accountId: w.hub.id, transferGroupId: randomUUID() },
        { amount: -700, accountId: w.hub.id, categoryId: w.cats.invest },
      ]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.lines.find((x) => x.name === 'Main account pot')!.actual).toBe(700);
    });

    it('treats a transfer-category row without a group as a transfer on the account', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await w.addTx([
        { amount: 8_000, accountId: w.sav.id, categoryId: w.cats.transfer },
        { amount: -1_000, accountId: w.sav.id, categoryId: w.cats.transfer },
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      expect(v.lines.find((l) => l.name === 'Emergency fund')!.actual).toBe(7_000);
    });

    async function twoSavingLines(w: World, count = 2) {
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const lines = [];
      for (const name of ['A', 'B', 'C'].slice(0, count)) {
        const l = await upsertBudgetLine(w.ctx, b.id, {
          kind: 'saving',
          name,
          accountId: w.sav.id,
        });
        await setLineAmounts(w.ctx, l.id, flat(10_000));
        lines.push(l);
      }
      return { b, lines };
    }

    it('a linked-category row on the line own account counts once, through the account', async () => {
      const w = await world();
      const s = await sheetBudget(w); // Emergency fund: account Savings, category Invest
      await w.addTx([
        { amount: 2_000, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: -700, accountId: w.sav.id, categoryId: w.cats.invest }, // on the line's account
        { amount: -300, accountId: w.hub.id, categoryId: w.cats.invest }, // on another account
      ]);
      const v = await budgetMonthView(w.ctx, s.b.id, 1);
      // account: 2 000 - 700 = 1 300; the other-account category row adds 300; no double count
      expect(v.lines.find((l) => l.name === 'Emergency fund')!.actual).toBe(1_600);
    });

    it('a linked-category row on a shared account is unassigned, not on any line', async () => {
      const w = await world();
      const { b, lines } = await twoSavingLines(w, 2);
      await linkCategories(w.ctx, lines[0]!.id, [w.cats.invest]);
      await w.addTx([{ amount: -700, accountId: w.sav.id, categoryId: w.cats.invest }]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.lines.map((l) => l.actual)).toEqual([0, 0]);
      expect(v.unassignedSavings).toEqual([
        { accountId: w.sav.id, accountName: 'Savings', actual: -700 },
      ]);
    });

    it('a sole whole-account line nets card spending against the transfers in', async () => {
      const w = await world();
      const { b } = await twoSavingLines(w, 1);
      await w.addTx([
        { amount: 60_000, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: 45_000, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: -60_000, accountId: w.sav.id, categoryId: w.cats.food }, // card spending
        { amount: 1_000, accountId: w.sav.id, status: 'pending' },
      ]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.lines[0]).toMatchObject({ actual: 45_000, pending: 1_000, noData: false });
      expect(v.unassignedSavings).toEqual([]);
    });

    it('two account lines on one account get 0 each and the flow is unassigned, never split', async () => {
      const w = await world();
      const { b } = await twoSavingLines(w, 3);
      await w.addTx([
        { amount: 10_001, accountId: w.sav.id, transferGroupId: randomUUID() },
        { amount: 500, accountId: w.sav.id, transferGroupId: randomUUID(), status: 'pending' },
      ]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.lines.map((l) => [l.actual, l.pending])).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
      expect(v.unassignedSavings).toEqual([
        { accountId: w.sav.id, accountName: 'Savings', actual: 10_001 },
      ]);
      expect(v.totals.saving).toMatchObject({ actual: 0, pending: 0 });
      const y = await budgetYearView(w.ctx, b.id);
      expect(y.totals.saving.total.actual).toBe(0);
    });

    it('shows unassigned savings only for months with a non-zero amount', async () => {
      const w = await world();
      const { b } = await twoSavingLines(w, 2);
      await w.addTx([
        {
          amount: 4_000,
          accountId: w.sav.id,
          transferGroupId: randomUUID(),
          bookingDate: '2026-02-10',
        },
      ]);
      expect((await budgetMonthView(w.ctx, b.id, 1)).unassignedSavings).toEqual([]);
      expect((await budgetMonthView(w.ctx, b.id, 2)).unassignedSavings[0]).toMatchObject({
        actual: 4_000,
      });
    });

    it('a saving line on the hub is never unassigned, even with several lines on it', async () => {
      const w = await world();
      await setHubAccount(w.ctx, w.hub.id);
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      for (const name of ['P1', 'P2'])
        await upsertBudgetLine(w.ctx, b.id, { kind: 'saving', name, accountId: w.hub.id });
      await w.addTx([{ amount: 9_000, accountId: w.hub.id, transferGroupId: randomUUID() }]);
      const v = await budgetMonthView(w.ctx, b.id, 1);
      expect(v.unassignedSavings).toEqual([]);
      expect(v.lines.map((l) => l.actual)).toEqual([0, 0]);
    });

    describe('bucket lines', () => {
      const brokerWorld = async () => {
        const w = await world();
        const broker = await createAccount(w.ctx, { name: 'Broker', type: 'investment' });
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const ids = new Map<string, string>();
        const bucket = async (name: string, removed = false): Promise<string> => {
          const [row] = await t.owner
            .insert(investmentBucket)
            .values({
              householdId: w.ctx.householdId,
              accountId: broker.id,
              provider: 'trading212',
              externalId: name,
              name,
              removedAt: removed ? new Date('2026-01-15T00:00:00Z') : null,
            })
            .returning({ id: investmentBucket.id });
          ids.set(name, row!.id);
          return row!.id;
        };
        const snap = async (asOf: string, name: string, investedMinor: number) => {
          const bucketId = ids.get(name) ?? (await bucket(name));
          await t.owner.insert(investmentBucketSnapshot).values({
            bucketId,
            householdId: w.ctx.householdId,
            accountId: broker.id,
            asOf,
            investedMinor,
            valueMinor: investedMinor + 5,
            currency: 'EUR',
          });
        };
        const posLine = async (name: string, buckets: string[]) =>
          saveBudgetLine(w.ctx, b.id, {
            line: { kind: 'saving', groupId: null, name, accountId: broker.id },
            amounts: flat(10_000),
            categoryIds: [],
            bucketIds: await Promise.all(buckets.map((n) => ids.get(n) ?? bucket(n))),
          });
        const acctLine = async (name: string) => {
          const l = await upsertBudgetLine(w.ctx, b.id, {
            kind: 'saving',
            name,
            accountId: broker.id,
          });
          await setLineAmounts(w.ctx, l.id, flat(10_000));
          return l;
        };
        return { w, broker, b, snap, posLine, acctLine, bucket };
      };

      afterEach(() => {
        vi.useRealTimers();
      });

      it('uses the invested delta of the linked pies, not the transfers into the account', async () => {
        const { w, broker, b, snap, posLine } = await brokerWorld();
        await posLine('ETF', ['Growth']);
        await snap('2025-12-31', 'Growth', 100_000);
        await snap('2026-01-31', 'Growth', 130_000);
        await w.addTx([{ amount: 50_000, accountId: broker.id, transferGroupId: randomUUID() }]);
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines[0]).toMatchObject({ actual: 30_000, pending: 0, noData: false });
        // 50 000 arrived on the account, 30 000 of it is invested in the line's pie
        expect(v.unassignedSavings).toEqual([
          { accountId: broker.id, accountName: 'Broker', actual: 20_000 },
        ]);
        expect(v.totals.saving.actual).toBe(30_000);
      });

      it('a pie line and an account line on one account: residual is unassigned', async () => {
        const { w, broker, b, snap, posLine, acctLine } = await brokerWorld();
        await posLine('ETF', ['Growth']);
        await acctLine('Cash');
        await snap('2025-12-31', 'Growth', 100_000);
        await snap('2026-01-31', 'Growth', 130_000);
        await w.addTx([{ amount: 70_000, accountId: broker.id, transferGroupId: randomUUID() }]);
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines.map((l) => [l.name, l.actual]).sort()).toEqual([
          ['Cash', 0],
          ['ETF', 30_000],
        ]);
        expect(v.unassignedSavings).toEqual([
          { accountId: broker.id, accountName: 'Broker', actual: 40_000 },
        ]);
      });

      it('is noData, with actual 0, when there is no baseline snapshot', async () => {
        const { w, b, snap, posLine } = await brokerWorld();
        await posLine('ETF', ['Growth']);
        await snap('2026-01-20', 'Growth', 130_000); // nothing before 1 Jan
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines[0]).toMatchObject({ actual: 0, noData: true });
        // February has the January snapshot as baseline: known (0 invested that month)
        const feb = await budgetMonthView(w.ctx, b.id, 2);
        expect(feb.lines[0]).toMatchObject({ actual: 0, noData: false });
        const y = await budgetYearView(w.ctx, b.id);
        expect(y.lines[0]!.months.slice(0, 3).map((m) => m.noData)).toEqual([true, false, false]);
        expect(y.totals.saving.months.every((m) => m.noData === false)).toBe(true);
      });

      it('uses a snapshot from the first three days of the month as baseline when none is older', async () => {
        const { w, b, snap, posLine } = await brokerWorld();
        await posLine('ETF', ['Growth']);
        await snap('2026-01-03', 'Growth', 100_000); // first snapshot, within the 3-day grace
        await snap('2026-01-31', 'Growth', 130_000);
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines[0]).toMatchObject({ actual: 30_000, noData: false });
      });

      it('sets staleAsOf only for the current month when the latest snapshot is over 3 days old', async () => {
        const { w, b, snap, posLine } = await brokerWorld();
        await posLine('ETF', ['Growth']);
        await snap('2025-12-31', 'Growth', 100_000);
        await snap('2026-01-10', 'Growth', 110_000);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-20T12:00:00Z'));
        expect((await budgetMonthView(w.ctx, b.id, 1)).lines[0]).toMatchObject({
          actual: 10_000,
          staleAsOf: '2026-01-10',
        });
        vi.setSystemTime(new Date('2026-01-13T12:00:00Z')); // exactly 3 days: not stale
        expect((await budgetMonthView(w.ctx, b.id, 1)).lines[0]!.staleAsOf).toBeNull();
        vi.setSystemTime(new Date('2026-02-20T12:00:00Z')); // January is no longer current
        expect((await budgetMonthView(w.ctx, b.id, 1)).lines[0]!.staleAsOf).toBeNull();
      });

      it('two pies on one account, two lines: each line gets its own pie delta, nothing unassigned', async () => {
        const { w, broker, b, snap, posLine } = await brokerWorld();
        await posLine('Growth line', ['Growth']);
        await posLine('Safe line', ['Safe']);
        await snap('2025-12-31', 'Growth', 100_000);
        await snap('2025-12-31', 'Safe', 50_000);
        await snap('2026-01-31', 'Growth', 130_000);
        await snap('2026-01-31', 'Safe', 70_000);
        await w.addTx([{ amount: 50_000, accountId: broker.id, transferGroupId: randomUUID() }]);
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines.map((l) => [l.name, l.actual]).sort()).toEqual([
          ['Growth line', 30_000],
          ['Safe line', 20_000],
        ]);
        expect(v.unassignedSavings).toEqual([]);
        expect(v.totals.saving.actual).toBe(50_000);
      });

      it('a linked pie absent from a later snapshot day counts 0 (sold out, pie removed)', async () => {
        const { w, b, snap, posLine, bucket } = await brokerWorld();
        await posLine('Growth line', ['Growth']);
        const other = await bucket('Other', true);
        void other;
        await snap('2025-12-31', 'Growth', 100_000);
        await snap('2025-12-31', 'Other', 10_000);
        await snap('2026-01-31', 'Other', 10_000); // Growth has no row on this day
        const v = await budgetMonthView(w.ctx, b.id, 1);
        expect(v.lines[0]).toMatchObject({ actual: -100_000, noData: false });
      });

      it('lines without pies never have staleAsOf', async () => {
        const w = await world();
        const s = await sheetBudget(w);
        const v = await budgetMonthView(w.ctx, s.b.id, 1);
        expect(v.lines.every((l) => l.staleAsOf === null && l.noData === false)).toBe(true);
      });
    });
  });

  describe('write robustness', () => {
    it('concurrent linkCategories on one category: one wins, the other gets ConflictError', async () => {
      for (let round = 0; round < 5; round++) {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const a = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
        const c = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'C' });
        const results = await Promise.allSettled([
          linkCategories(w.ctx, a.id, [w.cats.food]),
          linkCategories(w.ctx, c.id, [w.cats.food]),
        ]);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
          name: 'ConflictError',
          code: 'category_already_linked',
        });
      }
    });

    it('concurrent addCategoryToLine calls on one line keep every category', async () => {
      for (let round = 0; round < 5; round++) {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const a = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
        await Promise.all([
          addCategoryToLine(w.ctx, a.id, w.cats.food),
          addCategoryToLine(w.ctx, a.id, w.cats.rent),
          addCategoryToLine(w.ctx, a.id, w.cats.fuel),
        ]);
        expect((await getBudgetLine(w.ctx, a.id)).categoryIds.sort()).toEqual(
          [w.cats.food, w.cats.rent, w.cats.fuel].sort(),
        );
      }
    });

    it('renaming a line onto an existing (kind, name) is a line_name_taken ValidationError', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'A' });
      const c = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'C' });
      await expect(
        upsertBudgetLine(w.ctx, b.id, { id: c.id, kind: 'expense', name: 'A' }),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'line_name_taken' });
      // The household is still usable afterwards.
      await expect(
        upsertBudgetLine(w.ctx, b.id, { id: c.id, kind: 'expense', name: 'D' }),
      ).resolves.toMatchObject({ name: 'D' });
    });

    it('setHubAccount creates the settings row when it is missing', async () => {
      const w = await world();
      await t.owner
        .delete(householdSettings)
        .where(eq(householdSettings.householdId, w.ctx.householdId));
      await setHubAccount(w.ctx, w.hub.id);
      const [row] = await t.owner
        .select()
        .from(householdSettings)
        .where(eq(householdSettings.householdId, w.ctx.householdId));
      expect(row).toMatchObject({ hubAccountId: w.hub.id, currency: 'EUR' });
    });

    it('throws instead of silently losing precision when a sum exceeds the safe integer range', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const [acc] = [w.hub.id];
      await t.owner.execute(sql`
        insert into "transaction" (household_id, account_id, dedupe_hash, booking_date, amount,
          currency, status, raw_description, source, category_id)
        values (${w.ctx.householdId}, ${acc}::uuid, 'huge', '2026-01-10', -9007199254740993, 'EUR',
          'booked', 'x', 'manual', ${w.cats.food}::uuid)`);
      await expect(budgetMonthView(w.ctx, s.b.id, 1)).rejects.toThrow(/safe integer/i);
    });

    it('copies a budget whose source lost a category link to a deleted category', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await t.owner.delete(schema.category).where(eq(schema.category.id, w.cats.fuel));
      const copy = await createBudget(w.ctx, {
        startMonth: '2027-01-01',
        copyFromBudgetId: s.b.id,
      });
      const dst = await getBudget(w.ctx, copy.id);
      expect(dst.lines.find((l) => l.name === 'Fuel')!.categoryIds).toEqual([]);
      expect(dst.lines).toHaveLength(5);
    });
  });

  describe('unbudgeted spending', () => {
    it('lists expense-category and uncategorised spend that no line covers', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const extra = (await createCategory(w.ctx, { groupId: w.groups.home, name: 'Gifts' })).id;
      await w.addTx([
        { amount: -5_000, categoryId: extra },
        { amount: 1_000, categoryId: extra },
        { amount: -300, categoryId: extra, status: 'pending' },
        { amount: -700 }, // uncategorised outflow
        { amount: 9_999 }, // uncategorised inflow: not spending
        { amount: -8_000, categoryId: w.cats.food }, // linked: budgeted
        { amount: 5_000, categoryId: w.cats.salary }, // income category: not spending
        { amount: -4_000, categoryId: extra, currency: 'USD' },
      ]);
      const rows = await unbudgetedSpending(w.ctx, s.b.id, 1);
      expect(rows).toEqual([
        {
          categoryId: extra,
          categoryName: 'Gifts',
          actual: 4_000,
          pending: 300,
          foreignCurrencyRows: 1,
        },
        { categoryId: null, categoryName: null, actual: 700, pending: 0, foreignCurrencyRows: 0 },
      ]);
    });
  });

  describe('hub account and transfer plan', () => {
    it('reports configured false until a hub account is set', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      expect(await transferPlan(w.ctx, s.b.id, 1)).toEqual({ configured: false });
    });

    it('plans what to move from the hub and the remainder', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await setHubAccount(w.ctx, w.hub.id);
      const p = await transferPlan(w.ctx, s.b.id, 1);
      // income 3000 on hub; rent+fuel (no account) 1050 stay in hub; food 400 -> card; saving 500 -> sav
      expect(p).toEqual({
        configured: true,
        hubAccountId: w.hub.id,
        monthIndex: 1,
        perAccount: [
          { accountId: w.card.id, amount: 40_000, surplus: 0 },
          { accountId: w.sav.id, amount: 50_000, surplus: 0 },
        ].sort((a, b) => (a.accountId < b.accountId ? -1 : 1)),
        hubIncome: 300_000,
        hubOutgoing: 90_000 + 15_000,
        remainingInHub: 300_000 - 90_000 - 15_000 - 40_000 - 50_000,
        negative: false,
      });
    });

    it('flags a negative hub remainder', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await setLineAmounts(w.ctx, s.salary.id, [...flat(100_000)]);
      await setHubAccount(w.ctx, w.hub.id);
      const p = await transferPlan(w.ctx, s.b.id, 2);
      expect(p).toMatchObject({ configured: true, negative: true });
      if (p.configured) expect(p.remainingInHub).toBe(100_000 - 195_000);
    });

    it('can clear the hub, and rejects accounts from another household', async () => {
      const w = await world();
      const o = await world();
      await setHubAccount(w.ctx, w.hub.id);
      await expect(setHubAccount(w.ctx, o.hub.id)).rejects.toBeInstanceOf(NotFoundError);
      await setHubAccount(w.ctx, null);
      const [settings] = await t.owner
        .select()
        .from(householdSettings)
        .where(eq(householdSettings.householdId, w.ctx.householdId));
      expect(settings!.hubAccountId).toBeNull();
    });
  });

  describe('getBudgetLine', () => {
    it('returns one line with its amounts and categories, to any role, only in its household', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const l = await upsertBudgetLine(w.ctx, b.id, { kind: 'expense', name: 'Food' });
      await setLineAmounts(w.ctx, l.id, flat(1_000));
      await linkCategories(w.ctx, l.id, [w.cats.salary]);
      const got = await getBudgetLine(withRole(w.ctx, 'viewer'), l.id);
      expect(got).toMatchObject({ id: l.id, name: 'Food', categoryIds: [w.cats.salary] });
      expect(got.amounts).toEqual(flat(1_000));
      const other = await world();
      await expect(getBudgetLine(other.ctx, l.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getBudgetLine(w.ctx, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('household budget settings (owner only)', () => {
    const settingsOf = async (householdId: string) =>
      (
        await t.owner
          .select()
          .from(householdSettings)
          .where(eq(householdSettings.householdId, householdId))
      )[0]!;

    it('stores alert thresholds sorted ascending and treats [] as off', async () => {
      const w = await world();
      await setBudgetAlertThresholds(w.ctx, [100, 80, 150]);
      expect((await settingsOf(w.ctx.householdId)).budgetAlertThresholds).toEqual([80, 100, 150]);
      await setBudgetAlertThresholds(w.ctx, []);
      expect((await settingsOf(w.ctx.householdId)).budgetAlertThresholds).toEqual([]);
    });

    it('rejects thresholds that are out of range, not integers, duplicated or more than five', async () => {
      const w = await world();
      for (const bad of [[0], [201], [80.5], [80, 80], [10, 20, 30, 40, 50, 60], [Number.NaN]]) {
        await expect(setBudgetAlertThresholds(w.ctx, bad)).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(setBudgetAlertThresholds(w.ctx, [1, 200])).resolves.toBeUndefined();
      await expect(setBudgetAlertThresholds(w.ctx, [10, 20, 30, 40, 50])).resolves.toBeUndefined();
    });

    it('creates the settings row when it is missing, like the hub account', async () => {
      const w = await world();
      await t.owner
        .delete(householdSettings)
        .where(eq(householdSettings.householdId, w.ctx.householdId));
      await setBudgetAlertThresholds(w.ctx, [90]);
      expect((await settingsOf(w.ctx.householdId)).budgetAlertThresholds).toEqual([90]);
    });

    it('sets the fiscal year start month (1..12 only)', async () => {
      const w = await world();
      await setFiscalYearStartMonth(w.ctx, 4);
      expect((await settingsOf(w.ctx.householdId)).fiscalYearStartMonth).toBe(4);
      for (const bad of [0, 13, 2.5, Number.NaN]) {
        await expect(setFiscalYearStartMonth(w.ctx, bad)).rejects.toBeInstanceOf(ValidationError);
      }
    });

    it('saves all given settings in one go, or none of them', async () => {
      const w = await world();
      await updateBudgetSettings(w.ctx, {
        fiscalYearStartMonth: 4,
        hubAccountId: w.hub.id,
        budgetAlertThresholds: [100, 50],
      });
      let row = await settingsOf(w.ctx.householdId);
      expect([row.fiscalYearStartMonth, row.hubAccountId, row.budgetAlertThresholds]).toEqual([
        4,
        w.hub.id,
        [50, 100],
      ]);
      // An invalid list refuses the whole save: the other fields are not applied either.
      await expect(
        updateBudgetSettings(w.ctx, {
          fiscalYearStartMonth: 7,
          hubAccountId: null,
          budgetAlertThresholds: [80, 80],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        updateBudgetSettings(w.ctx, { fiscalYearStartMonth: 9, hubAccountId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundError);
      row = await settingsOf(w.ctx.householdId);
      expect([row.fiscalYearStartMonth, row.hubAccountId, row.budgetAlertThresholds]).toEqual([
        4,
        w.hub.id,
        [50, 100],
      ]);
      // Omitted fields stay as they are; null clears the hub.
      await updateBudgetSettings(w.ctx, { hubAccountId: null });
      row = await settingsOf(w.ctx.householdId);
      expect([row.fiscalYearStartMonth, row.hubAccountId, row.budgetAlertThresholds]).toEqual([
        4,
        null,
        [50, 100],
      ]);
      for (const role of ['member', 'viewer'] as const) {
        await expect(
          updateBudgetSettings(withRole(w.ctx, role), { fiscalYearStartMonth: 2 }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
    });

    it('answers NotFound, not a database error, for an empty or malformed hub account id', async () => {
      const w = await world();
      await updateBudgetSettings(w.ctx, { hubAccountId: w.hub.id });
      for (const bad of ['', 'not-a-uuid']) {
        await expect(updateBudgetSettings(w.ctx, { hubAccountId: bad })).rejects.toBeInstanceOf(
          NotFoundError,
        );
      }
      expect((await settingsOf(w.ctx.householdId)).hubAccountId).toBe(w.hub.id);
    });

    it('lets only owners change thresholds, the hub account and the fiscal year start', async () => {
      const w = await world();
      for (const role of ['member', 'viewer'] as const) {
        const c = withRole(w.ctx, role);
        await expect(setBudgetAlertThresholds(c, [80])).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setHubAccount(c, w.hub.id)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setFiscalYearStartMonth(c, 2)).rejects.toBeInstanceOf(ForbiddenError);
      }
      const row = await settingsOf(w.ctx.householdId);
      expect(row.hubAccountId).toBeNull();
      expect(row.fiscalYearStartMonth).toBe(1);
    });
  });

  describe('saveBudgetLine (atomic editor save)', () => {
    describe('bucket links', () => {
      const saving = { kind: 'saving' as const, groupId: null };

      const save = (
        w: World,
        budgetId: string,
        name: string,
        accountId: string | null,
        bucketIds?: string[],
        kind: 'saving' | 'expense' = 'saving',
      ) =>
        saveBudgetLine(w.ctx, budgetId, {
          line: { ...saving, kind, name, accountId },
          amounts: flat(100),
          categoryIds: [],
          bucketIds,
        });

      const broker = (w: World, name = 'Broker') =>
        createAccount(w.ctx, { name, type: 'investment' });

      const mkBucket = async (householdId: string, accountId: string, name: string) => {
        const [row] = await t.owner
          .insert(investmentBucket)
          .values({ householdId, accountId, provider: 'trading212', externalId: name, name })
          .returning({ id: investmentBucket.id });
        return row!.id;
      };

      it('stores and returns bucketIds', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        const safe = await mkBucket(w.ctx.householdId, acc.id, 'Safe');
        const saved = await save(w, b.id, 'ETF', acc.id, [growth, safe, growth]);
        expect([...saved.bucketIds].sort()).toEqual([growth, safe].sort());
        const got = await getBudgetLine(w.ctx, saved.id);
        expect([...got.bucketIds].sort()).toEqual([growth, safe].sort());
        const replaced = await save(w, b.id, 'ETF', acc.id, [safe]);
        expect(replaced.bucketIds).toEqual([safe]);
      });

      it('rejects buckets on a non-investment account or a non-saving line', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        await expect(save(w, b.id, 'A', w.sav.id, [growth])).rejects.toMatchObject({
          code: 'buckets_need_investment_account',
        });
        await expect(save(w, b.id, 'B', null, [growth])).rejects.toMatchObject({
          code: 'buckets_need_investment_account',
        });
        await expect(save(w, b.id, 'C', acc.id, [growth], 'expense')).rejects.toMatchObject({
          code: 'buckets_need_investment_account',
        });
        await expect(save(w, b.id, 'D', acc.id, ['not-a-uuid'])).rejects.toBeInstanceOf(
          ValidationError,
        );
      });

      it('rejects a bucket that does not exist or belongs to another account or household', async () => {
        const w = await world();
        const other = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const acc2 = await broker(w, 'Broker 2');
        const foreignAccount = await broker(other, 'Foreign');
        const elsewhere = await mkBucket(w.ctx.householdId, acc2.id, 'Elsewhere');
        const foreign = await mkBucket(other.ctx.householdId, foreignAccount.id, 'Foreign');
        for (const id of [randomUUID(), elsewhere, foreign]) {
          await expect(save(w, b.id, 'ETF', acc.id, [id])).rejects.toBeInstanceOf(NotFoundError);
        }
        expect((await getBudget(w.ctx, b.id)).lines).toEqual([]);
      });

      it('clears links when saved without buckets, even on another account type', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        const line = await save(w, b.id, 'ETF', acc.id, [growth]);
        const again = await saveBudgetLine(w.ctx, b.id, {
          line: { ...saving, id: line.id, name: 'ETF', accountId: w.sav.id },
          amounts: flat(100),
          categoryIds: [],
        });
        expect(again.bucketIds).toEqual([]);
      });

      it('refuses a bucket linked to two lines of one budget', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        await save(w, b.id, 'One', acc.id, [growth]);
        await expect(save(w, b.id, 'Two', acc.id, [growth])).rejects.toMatchObject({
          code: 'bucket_already_linked',
        });
        expect((await getBudget(w.ctx, b.id)).lines.map((l) => l.name)).toEqual(['One']);
      });

      it('concurrent links of one bucket: one wins, the other gets ConflictError', async () => {
        for (let round = 0; round < 5; round++) {
          const w = await world();
          const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
          const acc = await broker(w);
          const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
          const results = await Promise.allSettled([
            save(w, b.id, 'One', acc.id, [growth]),
            save(w, b.id, 'Two', acc.id, [growth]),
          ]);
          const rejected = results.filter((r) => r.status === 'rejected');
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
          expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
            name: 'ConflictError',
            code: 'bucket_already_linked',
          });
        }
      });

      it('allows the same bucket in another budget', async () => {
        const w = await world();
        const b1 = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const b2 = await createBudget(w.ctx, { startMonth: '2027-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        await save(w, b1.id, 'One', acc.id, [growth]);
        const other = await save(w, b2.id, 'One', acc.id, [growth]);
        expect(other.bucketIds).toEqual([growth]);
      });

      it('copies bucket links when copying a budget', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        const safe = await mkBucket(w.ctx.householdId, acc.id, 'Safe');
        await save(w, b.id, 'ETF', acc.id, [growth, safe]);
        const copy = await createBudget(w.ctx, {
          startMonth: '2027-01-01',
          copyFromBudgetId: b.id,
        });
        const dst = await getBudget(w.ctx, copy.id);
        expect([...dst.lines[0]!.bucketIds].sort()).toEqual([growth, safe].sort());
      });

      it('leaves links alone when a line is upserted without the editor', async () => {
        const w = await world();
        const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
        const acc = await broker(w);
        const growth = await mkBucket(w.ctx.householdId, acc.id, 'Growth');
        const line = await save(w, b.id, 'ETF', acc.id, [growth]);
        await upsertBudgetLine(w.ctx, b.id, {
          id: line.id,
          kind: 'saving',
          name: 'ETF 2',
          accountId: acc.id,
        });
        expect((await getBudgetLine(w.ctx, line.id)).bucketIds).toEqual([growth]);
      });
    });

    const base = { kind: 'expense' as const, groupId: null, accountId: null };

    it('creates a line with amounts and links in one call and returns it complete', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const amounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => n * 100);
      const saved = await saveBudgetLine(w.ctx, b.id, {
        line: {
          kind: 'expense',
          name: 'Rent',
          groupId: w.groups.home,
          accountId: w.card.id,
          notes: 'note',
        },
        amounts,
        categoryIds: [w.cats.rent, w.cats.food],
      });
      expect(saved).toMatchObject({
        budgetId: b.id,
        kind: 'expense',
        name: 'Rent',
        groupId: w.groups.home,
        accountId: w.card.id,
        notes: 'note',
        amounts,
      });
      expect([...saved.categoryIds].sort()).toEqual([w.cats.rent, w.cats.food].sort());
      const got = await getBudget(w.ctx, b.id);
      expect(got.lines).toHaveLength(1);
      expect(got.lines[0]).toMatchObject({ id: saved.id, amounts });
      expect([...got.lines[0]!.categoryIds].sort()).toEqual([w.cats.rent, w.cats.food].sort());
    });

    it('updates an existing line, replacing amounts and links and clearing optional fields', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await upsertBudgetLine(w.ctx, s.b.id, { kind: 'expense', name: 'Food', notes: 'old' });
      const saved = await saveBudgetLine(w.ctx, s.b.id, {
        line: { ...base, id: s.food.id, name: 'Groceries', notes: null },
        amounts: flat(123),
        categoryIds: [w.cats.food],
      });
      expect(saved).toMatchObject({
        id: s.food.id,
        name: 'Groceries',
        groupId: null,
        accountId: null,
        notes: null,
        amounts: flat(123),
        categoryIds: [w.cats.food],
      });
      const got = (await getBudget(w.ctx, s.b.id)).lines.find((l) => l.id === s.food.id)!;
      expect(got).toMatchObject({ name: 'Groceries', amounts: flat(123), groupId: null });
    });

    it('rolls everything back when the category link clashes (create leaves no line)', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await expect(
        saveBudgetLine(w.ctx, s.b.id, {
          line: { ...base, name: 'Brand new' },
          amounts: flat(5),
          categoryIds: [w.cats.rent], // already linked to Rent
        }),
      ).rejects.toMatchObject({ name: 'ConflictError', code: 'category_already_linked' });
      const got = await getBudget(w.ctx, s.b.id);
      expect(got.lines.map((l) => l.name)).not.toContain('Brand new');
    });

    it('rolls back an update: neither the name nor the amounts change when a part fails', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await expect(
        saveBudgetLine(w.ctx, s.b.id, {
          line: { ...base, id: s.fuel.id, name: 'Renamed' },
          amounts: flat(1),
          categoryIds: [w.cats.rent],
        }),
      ).rejects.toMatchObject({ code: 'category_already_linked' });
      const fuel = (await getBudget(w.ctx, s.b.id)).lines.find((l) => l.id === s.fuel.id)!;
      expect(fuel).toMatchObject({
        name: 'Fuel',
        amounts: flat(15_000),
        categoryIds: [w.cats.fuel],
      });
    });

    it('keeps the error codes of the parts', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      await expect(
        saveBudgetLine(w.ctx, s.b.id, {
          line: { ...base, id: s.fuel.id, name: 'Rent' },
          amounts: flat(1),
          categoryIds: [],
        }),
      ).rejects.toMatchObject({ code: 'line_name_taken' });
      await expect(
        saveBudgetLine(w.ctx, s.b.id, {
          line: { ...base, name: 'X' },
          amounts: flat(1),
          categoryIds: [w.cats.transfer],
        }),
      ).rejects.toMatchObject({ code: 'transfer_category' });
      await expect(
        saveBudgetLine(w.ctx, s.b.id, {
          line: { ...base, name: 'X' },
          amounts: [1],
          categoryIds: [],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        saveBudgetLine(w.ctx, randomUUID(), {
          line: { ...base, name: 'X' },
          amounts: flat(1),
          categoryIds: [],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await getBudget(w.ctx, s.b.id)).lines.map((l) => l.name)).not.toContain('X');
    });

    it('returns the stored line, equal to a fresh read', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const amounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => n * 100);
      const extra = (await createCategory(w.ctx, { groupId: w.groups.home, name: 'Extra' })).id;
      const saved = await saveBudgetLine(w.ctx, s.b.id, {
        line: { ...base, name: 'Stored', notes: 'n' },
        amounts,
        categoryIds: [extra, extra],
      });
      expect(saved).toEqual(await getBudgetLine(w.ctx, saved.id));
      expect(saved).toMatchObject({ name: 'Stored', amounts, categoryIds: [extra] });
    });

    it('is for writers only', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      const input = { line: { ...base, name: 'X' }, amounts: flat(1), categoryIds: [] };
      await expect(saveBudgetLine(withRole(w.ctx, 'viewer'), s.b.id, input)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(saveBudgetLine(withRole(w.ctx, 'member'), s.b.id, input)).resolves.toMatchObject(
        { name: 'X' },
      );
    });
  });

  describe('rename, archive and unarchive', () => {
    it('renames a budget (1..80 characters, trimmed)', async () => {
      const w = await world();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await expect(renameBudget(w.ctx, b.id, '  Casa 2026 ')).resolves.toMatchObject({
        id: b.id,
        name: 'Casa 2026',
      });
      for (const bad of ['', '   ', 'x'.repeat(81)]) {
        await expect(renameBudget(w.ctx, b.id, bad)).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(renameBudget(w.ctx, b.id, 'x'.repeat(80))).resolves.toBeDefined();
      await expect(renameBudget(w.ctx, randomUUID(), 'a')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('archives and unarchives, and listBudgets reports the status', async () => {
      const w = await world();
      const a = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      const b = await createBudget(w.ctx, { startMonth: '2027-01-01' });
      await expect(archiveBudget(w.ctx, a.id)).resolves.toMatchObject({
        id: a.id,
        status: 'archived',
      });
      await expect(archiveBudget(w.ctx, a.id)).resolves.toMatchObject({ status: 'archived' });
      expect((await listBudgets(w.ctx)).map((x) => [x.id, x.status])).toEqual([
        [b.id, 'active'],
        [a.id, 'archived'],
      ]);
      await expect(unarchiveBudget(w.ctx, a.id)).resolves.toMatchObject({ status: 'active' });
      expect((await listBudgets(w.ctx)).every((x) => x.status === 'active')).toBe(true);
    });

    it('is household-isolated and writers only', async () => {
      const w = await world();
      const other = await t.household();
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await expect(renameBudget(other, b.id, 'x')).rejects.toBeInstanceOf(NotFoundError);
      await expect(archiveBudget(other, b.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(unarchiveBudget(other, b.id)).rejects.toBeInstanceOf(NotFoundError);
      const v = withRole(w.ctx, 'viewer');
      await expect(renameBudget(v, b.id, 'x')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(archiveBudget(v, b.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(unarchiveBudget(v, b.id)).rejects.toBeInstanceOf(ForbiddenError);
      expect((await getBudget(w.ctx, b.id)).status).toBe('active');
    });
  });

  describe('performance', () => {
    it('uses the (household_id, purchase_date) index for a month range, not a seq scan on transaction', async () => {
      const w = await world();
      const s = await sheetBudget(w);
      // ~3 years of rows so a single month is a small slice of the table.
      const base = Date.UTC(2024, 0, 1);
      const rows = Array.from({ length: 6_000 }, (_, i) => ({
        householdId: w.ctx.householdId,
        accountId: w.hub.id,
        dedupeHash: `perf${i}-${w.ctx.householdId}`,
        bookingDate: new Date(base + (i % 1_095) * 86_400_000).toISOString().slice(0, 10),
        amount: -(100 + (i % 50)),
        currency: 'EUR',
        status: 'booked' as const,
        rawDescription: 'perf',
        source: 'manual' as const,
        categoryId: [w.cats.food, w.cats.rent, w.cats.fuel][i % 3]!,
      }));
      for (let i = 0; i < rows.length; i += 1_000) {
        await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
          tx.insert(transaction).values(rows.slice(i, i + 1_000)),
        );
      }
      await t.owner.execute(sql`analyze "transaction"`);
      const plan = await withHousehold(w.ctx.db, w.ctx.householdId, async (tx) => {
        const q = budgetActualsQuery({
          householdId: w.ctx.householdId,
          budgetId: s.b.id,
          from: '2026-01-01',
          to: '2026-01-31',
          startMonth: '2026-01-01',
          currency: 'EUR',
          transferCategoryId: w.cats.transfer,
          hubAccountId: w.hub.id,
        });
        const res = await tx.execute(sql`explain (format json) ${q}`);
        return JSON.stringify(res);
      });
      expect(plan).not.toMatch(/"Node Type":\s*"Seq Scan"[^}]*"Relation Name":\s*"transaction"/);
      expect(plan).toMatch(/transaction_household_purchase_date_idx/);
    });
  });
});
