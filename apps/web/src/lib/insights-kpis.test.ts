import { describe, expect, it } from 'vitest';
import { monthKpis } from './insights-kpis';

const row = (month: string, income: number, expense: number, saving = 0) => ({
  month,
  income,
  expense,
  saving,
  net: income - expense,
});

const rows = [
  row('2026-07-01', 100_000, 60_000),
  row('2026-08-01', 120_000, 80_000, 20_000),
  row('2026-09-01', 110_000, 50_000, 30_000),
  row('2026-10-01', 200_000, 100_000, 50_000),
];

describe('monthKpis', () => {
  it('sums the selected months and compares spending with the period before', () => {
    const k = monthKpis(rows, ['2026-10-01']);
    expect(k.expense).toBe(100_000);
    expect(k.income).toBe(200_000);
    expect(k.savingRateBps).toBe(2500);
    expect(k.previous).toEqual({ expense: 50_000, deltaMinor: 50_000, deltaBps: 10_000 });
  });

  it('compares a three-month period with the three months before when they exist', () => {
    const k = monthKpis(rows, ['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(k.expense).toBe(230_000);
    expect(k.previous).toBeNull();
  });

  it('has no savings rate without income and no percentage change from zero spending', () => {
    const zero = [row('2026-09-01', 0, 0), row('2026-10-01', 0, 5_000)];
    const k = monthKpis(zero, ['2026-10-01']);
    expect(k.savingRateBps).toBeNull();
    expect(k.previous).toEqual({ expense: 0, deltaMinor: 5_000, deltaBps: null });
  });

  it('ignores months missing from the rows', () => {
    expect(monthKpis(rows, ['2025-01-01']).previous).toBeNull();
  });
});
