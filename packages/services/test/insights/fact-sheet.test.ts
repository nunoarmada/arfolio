import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  buildFactSheet,
  createBudget,
  createCategory,
  createCategoryGroup,
  hasActivity,
  saveBudgetLine,
  ValidationError,
  type FactSheet,
} from '../../src/index.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';
import { insightsWorld } from './world.js';

const MONTH = '2026-09';
const NOW = new Date('2026-10-05T12:00:00Z');

/** Every key of every object in `value`, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

describe('buildFactSheet', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const build = (w: Awaited<ReturnType<typeof insightsWorld>>, month = MONTH) =>
    buildFactSheet(w.ctx, { month }, NOW);

  /** A household with history, a budget, recurring items and net worth snapshots. */
  async function populated() {
    const w = await insightsWorld(t);
    // income and spending: June, July, August (the 3 months before) and September
    for (const [m, income, groc, rent] of [
      ['2026-06', 200_000, 30_000, 80_000],
      ['2026-07', 220_000, 30_000, 80_000],
      ['2026-08', 240_000, 60_000, 80_000],
      ['2026-09', 300_000, 90_001, 80_000],
    ] as const) {
      await w.add(w.main, `${m}-01`, income, { categoryId: w.cats.salary });
      await w.add(w.main, `${m}-05`, -groc, { categoryId: w.cats.groceries });
      await w.add(w.main, `${m}-02`, -rent, { categoryId: w.cats.rent });
    }
    await w.spendIn(w.cats.groceries, ['2026-03', '2026-04', '2026-05'], 30_000);
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await saveBudgetLine(w.ctx, b.id, {
      line: { kind: 'expense', name: 'Food line', groupId: w.groups.food },
      amounts: Array.from({ length: 12 }, () => 50_000),
      categoryIds: [w.cats.groceries],
    });
    await w.addRecurring({
      name: 'Streamy',
      amount: -1_299,
      status: 'confirmed',
      createdAt: new Date('2026-09-10T10:00:00Z'),
    });
    await w.addRecurring({
      name: 'Gym',
      amount: -3_000,
      status: 'confirmed',
      source: 'declared',
      cadence: 'monthly',
      createdAt: new Date('2026-01-10T10:00:00Z'),
    });
    await w.addPriceChange({
      name: 'Streamy',
      previousAmount: -999,
      amount: -1_299,
      date: '2026-09-15',
    });
    const snap = (month: string, net: number) =>
      t.owner.insert(schema.netWorthSnapshot).values({
        householdId: w.ctx.householdId,
        month,
        assets: net,
        liabilities: 0,
        net,
        breakdown: { byKind: {}, foreignCount: 0 },
      });
    await snap('2025-09-01', 1_000_000);
    await snap('2026-08-01', 1_200_000);
    await snap('2026-09-01', 1_250_050);
    return w;
  }

  it('sums the month into decimal strings, with the previous month and the 3-month average', async () => {
    const f = await build(await populated());
    expect(f).toMatchObject({ schemaVersion: 1, month: MONTH, currency: 'EUR' });
    expect(f.totals).toEqual({
      income: '3000.00',
      expense: '1700.01',
      saving: '0.00',
      net: '1299.99',
    });
    expect(f.previous).toEqual({
      income: '2400.00',
      expense: '1400.00',
      saving: '0.00',
      net: '1000.00',
    });
    // June..August: income 2200, expense (1100 + 1100 + 1400) / 3
    expect(f.avg3).toEqual({
      income: '2200.00',
      expense: '1200.00',
      saving: '0.00',
      net: '1000.00',
    });
  });

  it('averages the 3 months before over the months that have activity, not a fixed 3', async () => {
    const w = await insightsWorld(t);
    // Only August has history before September: the average is August, not a third of it.
    await w.add(w.main, '2026-08-01', 240_000, { categoryId: w.cats.salary });
    await w.add(w.main, '2026-08-05', -60_000, { categoryId: w.cats.groceries });
    await w.add(w.main, '2026-09-05', -10_000, { categoryId: w.cats.groceries });
    const f = await build(w);
    expect(f.avg3).toEqual({
      income: '2400.00',
      expense: '600.00',
      saving: '0.00',
      net: '1800.00',
    });
    // No history at all: zeros, not a division by nothing.
    const empty = await build(await insightsWorld(t));
    expect(empty.avg3).toEqual({ income: '0.00', expense: '0.00', saving: '0.00', net: '0.00' });
  });

  it('lists category groups with the month, the budget and the previous month', async () => {
    const f = await build(await populated());
    expect(f.groups).toEqual([
      { name: 'Food', actual: '900.01', budget: '500.00', prevActual: '600.00' },
      { name: 'Home', actual: '800.00', budget: null, prevActual: '800.00' },
    ]);
  });

  it('lists the top 10 expense budget lines by absolute deviation', async () => {
    const w = await insightsWorld(t);
    const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
    await saveBudgetLine(w.ctx, b.id, {
      line: { kind: 'expense', name: 'Food line', groupId: w.groups.food },
      amounts: Array.from({ length: 12 }, () => 50_000),
      categoryIds: [w.cats.groceries],
    });
    for (let i = 1; i <= 11; i += 1) {
      await saveBudgetLine(w.ctx, b.id, {
        line: { kind: 'expense', name: `Line ${String(i).padStart(2, '0')}` },
        amounts: Array.from({ length: 12 }, () => i * 1_000),
        categoryIds: [],
      });
    }
    await saveBudgetLine(w.ctx, b.id, {
      line: { kind: 'income', name: 'Pay line' },
      amounts: Array.from({ length: 12 }, () => 999_999),
      categoryIds: [w.cats.salary],
    });
    await w.add(w.main, '2026-09-05', -70_000, { categoryId: w.cats.groceries });
    const f = await build(w);
    expect(f.budgetLines).toHaveLength(10);
    // deviation: Food line 200, then Line 11 .. Line 03 (planned 110 .. 30 with nothing spent)
    expect(f.budgetLines[0]).toEqual({ name: 'Food line', actual: '700.00', planned: '500.00' });
    expect(f.budgetLines[1]).toEqual({ name: 'Line 11', actual: '0.00', planned: '110.00' });
    expect(f.budgetLines.map((l) => l.name)).not.toContain('Pay line');
    expect(f.budgetLines.map((l) => l.name)).not.toContain('Line 01');
  });

  it('reports recurring cost and changes, net worth, anomalies and the foreign count', async () => {
    const w = await populated();
    await w.add(w.main, '2026-09-20', -4_000, { currency: 'USD', categoryId: w.cats.dining });
    await w.add(w.main, '2026-09-21', -4_000, { currency: 'USD' });
    const f = await build(w);
    expect(f.recurring.monthlyCost).toBe('42.99');
    expect(f.recurring.changes).toEqual([
      {
        type: 'new_recurring',
        name: 'Streamy',
        nameKnown: true,
        category: null,
        amount: '12.99',
        cadence: 'monthly',
      },
      {
        type: 'recurring_price_change',
        name: 'Streamy',
        nameKnown: false,
        category: null,
        before: '9.99',
        after: '12.99',
      },
    ]);
    expect(f.netWorth).toEqual({ now: '12500.50', monthStart: '12000.00', change12m: '2500.50' });
    expect(f.anomalies.map((a) => a.type)).toEqual([
      'category_spike',
      'budget_overrun',
      'new_recurring',
      'recurring_price_change',
    ]);
    expect(f.otherCurrencyCount).toBe(2);
    // other currencies are counted, never summed
    expect(f.totals.expense).toBe('1700.01');
  });

  it('has a null 12-month change without a snapshot a year back', async () => {
    const w = await insightsWorld(t);
    await t.owner.insert(schema.netWorthSnapshot).values({
      householdId: w.ctx.householdId,
      month: '2026-09-01',
      assets: 100,
      liabilities: 0,
      net: 100,
      breakdown: { byKind: {}, foreignCount: 0 },
    });
    const f = await build(w);
    expect(f.netWorth.change12m).toBeNull();
    expect(f.netWorth.now).toBe('1.00');
  });

  it('keeps budgets out when none covers the month', async () => {
    const f = await build(await insightsWorld(t));
    expect(f.budgetLines).toEqual([]);
    expect(f.groups).toEqual([]);
  });

  it('is plain JSON: it survives a round trip unchanged', async () => {
    const f = await build(await populated());
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  describe('what must never reach the model', () => {
    it('has no description, account or member fields, and no planted identifier', async () => {
      const w = await populated();
      const email = 'maria.silva@example.com';
      const iban = 'PT50000201231234567890154';
      await w.add(w.main, '2026-09-12', -50_000, {
        categoryId: w.cats.dining,
        description: `Pagamento ${email} ${iban} Maria Silva`,
      });
      await w.add(w.main, '2026-09-13', -900, { description: `Lunch with ${email}` });
      const f = await build(w);
      const keys = keysOf(f);
      expect(
        keys.filter((k) => /descri|account|member|user|iban|email|note|counterparty/i.test(k)),
      ).toEqual([]);
      const text = JSON.stringify(f);
      for (const needle of [email, iban, 'Maria Silva', 'Pagamento', 'Lunch', 'Main', 'Savings']) {
        expect(text).not.toContain(needle);
      }
    });

    it('redacts names through redactForAi', async () => {
      const w = await insightsWorld(t);
      const group = await createCategoryGroup(w.ctx, {
        name: 'Gifts maria@example.com',
        kind: 'expense',
      });
      const cat = await createCategory(w.ctx, { groupId: group.id, name: 'For 912345678901' });
      await w.add(w.main, '2026-09-05', -1_000, { categoryId: cat.id });
      const f = await build(w);
      expect(f.groups.map((x) => x.name)).toEqual(['Gifts #']);
      expect(JSON.stringify(f)).not.toMatch(/maria@|912345678901/);
    });
  });

  describe('hasActivity', () => {
    it('is false for an empty month and for a month of transfers only', async () => {
      const w = await insightsWorld(t);
      expect(hasActivity(await build(w))).toBe(false);
      await w.add(w.main, '2026-09-05', -50_000, { transferGroupId: randomUUID() });
      await w.add(w.savings, '2026-09-05', 50_000, { categoryId: w.transferId });
      await w.add(w.main, '2026-09-06', -5_000, { currency: 'USD' });
      const f = await build(w);
      expect(hasActivity(f)).toBe(false);
      expect(f.totals.income).toBe('0.00');
      expect(f.totals.expense).toBe('0.00');
      expect(f.otherCurrencyCount).toBe(1);
    });

    it('is true with any income or any expense', async () => {
      const a = await insightsWorld(t);
      await a.add(a.main, '2026-09-05', 100);
      expect(hasActivity(await build(a))).toBe(true);
      const b = await insightsWorld(t);
      await b.add(b.main, '2026-09-05', -100);
      expect(hasActivity(await build(b))).toBe(true);
    });
  });

  describe('month boundary in the household timezone', () => {
    it('counts a booking by its local date: 30 Sep is September, 1 Oct is October', async () => {
      const w = await insightsWorld(t, { timezone: 'Europe/Lisbon' });
      await w.add(w.main, '2026-09-30', -1_000, { categoryId: w.cats.groceries });
      await w.add(w.main, '2026-10-01', -2_000, { categoryId: w.cats.groceries });
      expect((await build(w, '2026-09')).totals.expense).toBe('10.00');
      expect((await build(w, '2026-10')).totals.expense).toBe('20.00');
    });

    it('puts a recurring item created at 23:30Z on 30 Sep in October for a Lisbon household', async () => {
      const createdAt = new Date('2026-09-30T23:30:00Z');
      const lisbon = await insightsWorld(t, { timezone: 'Europe/Lisbon' });
      await lisbon.addRecurring({
        name: 'Streamy',
        amount: -1_299,
        status: 'confirmed',
        createdAt,
      });
      expect((await build(lisbon, '2026-10')).recurring.changes).toHaveLength(1);
      expect((await build(lisbon, '2026-09')).recurring.changes).toEqual([]);
    });
  });

  it('rejects a malformed month', async () => {
    const w = await insightsWorld(t);
    await expect(buildFactSheet(w.ctx, { month: 'September' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('type: a FactSheet value is assignable from the builder', async () => {
    const w = await insightsWorld(t);
    const f: FactSheet = await build(w);
    expect(Object.keys(f).sort()).toEqual(
      [
        'anomalies',
        'avg3',
        'budgetLines',
        'currency',
        'groups',
        'month',
        'netWorth',
        'otherCurrencyCount',
        'previous',
        'recurring',
        'schemaVersion',
        'totals',
      ].sort(),
    );
  });
});
