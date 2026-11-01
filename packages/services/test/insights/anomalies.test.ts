import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBudget, detectAnomalies, saveBudgetLine, ValidationError } from '../../src/index.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';
import { insightsWorld, PRIOR } from './world.js';

const MONTH = '2026-09';

describe('detectAnomalies', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const only = async (w: Awaited<ReturnType<typeof insightsWorld>>, type: string, month = MONTH) =>
    (await detectAnomalies(w.ctx, { month })).filter((a) => a.type === type);

  describe('category_spike', () => {
    it('fires at exactly 1.5x the median and exactly 50 more, and carries decimal strings', async () => {
      const w = await insightsWorld(t);
      await w.spendIn(w.cats.groceries, PRIOR, 10_000);
      await w.add(w.main, '2026-09-05', -15_000, { categoryId: w.cats.groceries });
      expect(await only(w, 'category_spike')).toEqual([
        {
          type: 'category_spike',
          categoryId: w.cats.groceries,
          name: 'Groceries',
          amount: '150.00',
          baseline: '100.00',
        },
      ]);
    });

    it('does not fire just under 1.5x, even when the absolute floor is met', async () => {
      const w = await insightsWorld(t);
      await w.spendIn(w.cats.groceries, PRIOR, 10_000);
      await w.add(w.main, '2026-09-05', -14_999, { categoryId: w.cats.groceries });
      expect(await only(w, 'category_spike')).toEqual([]);
    });

    it('does not fire on small numbers: 2 to 9 is not an anomaly (absolute floor)', async () => {
      const w = await insightsWorld(t);
      await w.spendIn(w.cats.groceries, PRIOR, 200);
      await w.add(w.main, '2026-09-05', -900, { categoryId: w.cats.groceries });
      expect(await only(w, 'category_spike')).toEqual([]);
    });

    it('does not fire when 1.5x is met but the rise is 49.99', async () => {
      const w = await insightsWorld(t);
      // baseline 99.98: 149.97 is exactly 1.5x with a rise of 49.99
      await w.spendIn(w.cats.groceries, PRIOR, 9_998);
      await w.add(w.main, '2026-09-05', -14_997, { categoryId: w.cats.groceries });
      expect(await only(w, 'category_spike')).toEqual([]);
      await w.add(w.main, '2026-09-06', -1, { categoryId: w.cats.groceries });
      expect(await only(w, 'category_spike')).toHaveLength(1);
    });

    it('needs at least 3 prior months with spend, and uses the median of those months', async () => {
      const few = await insightsWorld(t);
      await few.spendIn(few.cats.groceries, ['2026-07', '2026-08'], 10_000);
      await few.add(few.main, '2026-09-05', -50_000, { categoryId: few.cats.groceries });
      expect(await only(few, 'category_spike')).toEqual([]);

      const three = await insightsWorld(t);
      await three.spendIn(three.cats.groceries, ['2026-06', '2026-07', '2026-08'], 10_000);
      await three.add(three.main, '2026-09-05', -50_000, { categoryId: three.cats.groceries });
      expect(await only(three, 'category_spike')).toHaveLength(1);

      // The median ignores one huge month; a mean (250) would hide the spike of 200.
      const med = await insightsWorld(t);
      await med.spendIn(med.cats.groceries, PRIOR.slice(0, 5), 10_000);
      await med.spendIn(med.cats.groceries, ['2026-08'], 100_000);
      await med.add(med.main, '2026-09-05', -20_000, { categoryId: med.cats.groceries });
      expect(await only(med, 'category_spike')).toMatchObject([{ baseline: '100.00' }]);
    });

    it('looks back 6 months only', async () => {
      const w = await insightsWorld(t);
      await w.spendIn(w.cats.groceries, ['2026-01', '2026-02', '2026-03', '2026-04'], 10_000);
      await w.add(w.main, '2026-09-05', -50_000, { categoryId: w.cats.groceries });
      // only March and April fall inside Mar-Aug
      expect(await only(w, 'category_spike')).toEqual([]);
    });

    it('ignores transfers, pending rows and other currencies', async () => {
      const w = await insightsWorld(t);
      await w.spendIn(w.cats.groceries, PRIOR, 10_000);
      await w.add(w.main, '2026-09-05', -90_000, {
        categoryId: w.cats.groceries,
        status: 'pending',
      });
      await w.add(w.main, '2026-09-06', -90_000, {
        categoryId: w.cats.groceries,
        currency: 'USD',
      });
      await w.add(w.main, '2026-09-07', -90_000, {
        categoryId: w.cats.groceries,
        transferGroupId: randomUUID(),
      });
      await w.add(w.main, '2026-09-08', -90_000, { categoryId: w.transferId });
      expect(await only(w, 'category_spike')).toEqual([]);
    });
  });

  describe('budget_overrun', () => {
    async function budgeted(planned: number, actual: number) {
      const w = await insightsWorld(t);
      const b = await createBudget(w.ctx, { startMonth: '2026-01-01' });
      await saveBudgetLine(w.ctx, b.id, {
        line: { kind: 'expense', name: 'Food line', groupId: w.groups.food },
        amounts: Array.from({ length: 12 }, () => planned),
        categoryIds: [w.cats.groceries],
      });
      await w.add(w.main, '2026-09-05', -actual, { categoryId: w.cats.groceries });
      return w;
    }

    it('fires over 110% and more than 25 over', async () => {
      const w = await budgeted(100_000, 110_100);
      const [a] = await only(w, 'budget_overrun');
      expect(a).toMatchObject({
        type: 'budget_overrun',
        name: 'Food line',
        actual: '1101.00',
        planned: '1000.00',
      });
      expect(a).toHaveProperty('lineId');
    });

    it('does not fire at exactly 110%', async () => {
      expect(await only(await budgeted(100_000, 110_000), 'budget_overrun')).toEqual([]);
    });

    it('needs more than 25 over: exactly 25 does not fire, 25.01 does', async () => {
      expect(await only(await budgeted(10_000, 12_500), 'budget_overrun')).toEqual([]);
      expect(await only(await budgeted(10_000, 12_501), 'budget_overrun')).toHaveLength(1);
    });

    it('has nothing to say without a budget covering the month, or for non-expense lines', async () => {
      const none = await insightsWorld(t);
      await none.add(none.main, '2026-09-05', -90_000, { categoryId: none.cats.groceries });
      expect(await detectAnomalies(none.ctx, { month: MONTH })).toEqual([]);

      const w = await budgeted(100_000, 150_000);
      expect(await only(w, 'budget_overrun', '2027-03')).toEqual([]); // budget year ended
      const inc = await insightsWorld(t);
      const b = await createBudget(inc.ctx, { startMonth: '2026-01-01' });
      await saveBudgetLine(inc.ctx, b.id, {
        line: { kind: 'income', name: 'Pay line' },
        amounts: Array.from({ length: 12 }, () => 1_000),
        categoryIds: [inc.cats.salary],
      });
      await inc.add(inc.main, '2026-09-05', 900_000, { categoryId: inc.cats.salary });
      expect(await only(inc, 'budget_overrun')).toEqual([]);
    });
  });

  describe('recurring', () => {
    it('new_recurring: first detected this month, in the household timezone', async () => {
      // 2026-09-30 23:30Z is already 1 October in Lisbon (WEST, UTC+1)
      const createdAt = new Date('2026-09-30T23:30:00Z');
      const lisbon = await insightsWorld(t, { timezone: 'Europe/Lisbon' });
      await lisbon.addRecurring({
        name: 'Streamy',
        amount: -1_299,
        cadence: 'monthly',
        status: 'confirmed',
        createdAt,
      });
      expect(await only(lisbon, 'new_recurring', '2026-10')).toEqual([
        {
          type: 'new_recurring',
          name: 'Streamy',
          nameKnown: true,
          category: null,
          amount: '12.99',
          cadence: 'monthly',
        },
      ]);
      expect(await only(lisbon, 'new_recurring', '2026-09')).toEqual([]);

      const utc = await insightsWorld(t, { timezone: 'UTC' });
      await utc.addRecurring({ name: 'Streamy', amount: -1_299, status: 'confirmed', createdAt });
      expect(await only(utc, 'new_recurring', '2026-09')).toHaveLength(1);
      expect(await only(utc, 'new_recurring', '2026-10')).toEqual([]);
    });

    it('new_recurring: skips dismissed, declared, income and other-currency items', async () => {
      const w = await insightsWorld(t);
      const createdAt = new Date('2026-09-15T10:00:00Z');
      await w.addRecurring({ name: 'Dismissed', amount: -500, status: 'dismissed', createdAt });
      await w.addRecurring({ name: 'Declared', amount: -500, source: 'declared', createdAt });
      await w.addRecurring({ name: 'Pay', amount: 200_000, status: 'confirmed', createdAt });
      await w.addRecurring({
        name: 'Dollar',
        amount: -500,
        currency: 'USD',
        status: 'confirmed',
        createdAt,
      });
      await w.addRecurring({
        name: 'Old',
        amount: -500,
        status: 'confirmed',
        createdAt: new Date('2026-08-15T10:00:00Z'),
      });
      expect(await only(w, 'new_recurring')).toEqual([]);
    });

    it('new_recurring: an unconfirmed detection is a guess and is not reported', async () => {
      const w = await insightsWorld(t);
      const createdAt = new Date('2026-09-15T10:00:00Z');
      await w.addRecurring({ name: 'Guess', amount: -700, createdAt });
      expect(await only(w, 'new_recurring')).toEqual([]);
      await w.addRecurring({ name: 'Sure', amount: -800, status: 'confirmed', createdAt });
      expect(await only(w, 'new_recurring')).toMatchObject([{ name: 'Sure' }]);
    });

    it('marks a recurring name as known only for a confirmed item, and carries its category', async () => {
      const w = await insightsWorld(t);
      const createdAt = new Date('2026-09-15T10:00:00Z');
      await w.addRecurring({
        name: 'Gym',
        amount: -2_000,
        status: 'confirmed',
        categoryId: w.cats.dining,
        createdAt,
      });
      expect(await only(w, 'new_recurring')).toMatchObject([
        { name: 'Gym', nameKnown: true, category: 'Dining' },
      ]);
    });

    it('recurring_price_change: the name is known only for a confirmed item', async () => {
      const w = await insightsWorld(t);
      const [gym] = await w.addRecurring({
        name: 'Gym',
        amount: -2_000,
        status: 'confirmed',
        categoryId: w.cats.dining,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      });
      const [raw] = await w.addRecurring({
        name: 'TRF P/ Someone',
        amount: -2_000,
        createdAt: new Date('2026-01-01T10:00:00Z'),
      });
      const base = { previousAmount: -2_000, amount: -2_500, date: '2026-09-15' };
      await w.addPriceChange({ name: 'Gym', recurringId: gym!.id, ...base });
      await w.addPriceChange({ name: 'TRF P/ Someone', recurringId: raw!.id, ...base });
      expect(await only(w, 'recurring_price_change')).toMatchObject([
        { name: 'Gym', nameKnown: true, category: 'Dining' },
        { name: 'TRF P/ Someone', nameKnown: false, category: null },
      ]);
    });

    it('recurring_price_change: read from the stored price-change notifications of the month', async () => {
      const w = await insightsWorld(t);
      await w.addPriceChange({
        name: 'Streamy',
        previousAmount: -999,
        amount: -1_299,
        date: '2026-09-15',
      });
      await w.addPriceChange({
        name: 'Last month',
        previousAmount: -999,
        amount: -1_299,
        date: '2026-08-31',
      });
      await w.addPriceChange({
        name: 'Dollar',
        previousAmount: -999,
        amount: -1_299,
        date: '2026-09-02',
        currency: 'USD',
      });
      expect(await only(w, 'recurring_price_change')).toEqual([
        {
          type: 'recurring_price_change',
          name: 'Streamy',
          nameKnown: false,
          category: null,
          before: '9.99',
          after: '12.99',
        },
      ]);
    });
  });

  describe('large_transaction', () => {
    async function withHistory(row: number) {
      const w = await insightsWorld(t);
      // ten prior rows of 100: the category's p90 is 100
      for (let i = 0; i < 10; i += 1) {
        await w.add(w.main, `2026-0${3 + (i % 6)}-1${i % 9}`, -10_000, {
          categoryId: w.cats.dining,
        });
      }
      await w.add(w.main, '2026-09-12', -row, {
        categoryId: w.cats.dining,
        description: 'Dinner with secret@example.com IBAN PT50000201231234567890154',
      });
      return w;
    }

    it('fires at exactly 3x the p90 (and 200+), identified by category and date only', async () => {
      const w = await withHistory(30_000);
      const found = await only(w, 'large_transaction');
      expect(found).toEqual([
        {
          type: 'large_transaction',
          categoryId: w.cats.dining,
          categoryName: 'Dining',
          amount: '300.00',
          date: '2026-09-12',
        },
      ]);
      const text = JSON.stringify(await detectAnomalies(w.ctx, { month: MONTH }));
      expect(text).not.toMatch(/secret|IBAN|Dinner|PT50/);
    });

    it('does not fire just under 3x the p90', async () => {
      expect(await only(await withHistory(29_999), 'large_transaction')).toEqual([]);
    });

    it('needs 200 or more: 3x of a small p90 is not enough', async () => {
      const w = await insightsWorld(t);
      for (let i = 0; i < 10; i += 1) {
        await w.add(w.main, `2026-0${3 + (i % 6)}-1${i % 9}`, -1_000, {
          categoryId: w.cats.dining,
        });
      }
      await w.add(w.main, '2026-09-12', -19_999, { categoryId: w.cats.dining });
      expect(await only(w, 'large_transaction')).toEqual([]);
      await w.add(w.main, '2026-09-13', -20_000, { categoryId: w.cats.dining });
      expect(await only(w, 'large_transaction')).toHaveLength(1);
    });

    it('needs prior history for the category, and ignores transfers', async () => {
      const w = await insightsWorld(t);
      await w.add(w.main, '2026-09-12', -500_000, { categoryId: w.cats.rent });
      await w.add(w.main, '2026-09-13', -500_000, { categoryId: w.transferId });
      await w.add(w.main, '2026-09-14', -500_000, { transferGroupId: randomUUID() });
      expect(await only(w, 'large_transaction')).toEqual([]);
    });
  });

  it('rejects a malformed month and accepts the first-of-month date form', async () => {
    const w = await insightsWorld(t);
    await expect(detectAnomalies(w.ctx, { month: '2026-13' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(detectAnomalies(w.ctx, { month: '2026-09-15' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await detectAnomalies(w.ctx, { month: '2026-09-01' })).toEqual([]);
  });

  it('is readable by a viewer', async () => {
    const w = await insightsWorld(t);
    expect(await detectAnomalies({ ...w.ctx, role: 'viewer' }, { month: MONTH })).toEqual([]);
  });
});
