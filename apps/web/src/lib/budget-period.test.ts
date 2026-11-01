import { describe, expect, it } from 'vitest';
import {
  covers,
  defaultMonth,
  monthIndexIn,
  monthState,
  monthsBetween,
  nearestCoveredMonth,
  nextStart,
  paceFraction,
  parseMonthParam,
  pickBudget,
  type BudgetRef,
} from './budget-period';

const budget = (id: string, startMonth: string, status: BudgetRef['status'] = 'active') => ({
  id,
  startMonth,
  name: id,
  status,
});

describe('parseMonthParam', () => {
  it('accepts yyyy-mm and yyyy-mm-01 and drops the rest', () => {
    expect(parseMonthParam('2026-10')).toBe('2026-10-01');
    expect(parseMonthParam('2026-10-01')).toBe('2026-10-01');
    for (const bad of ['2026-13', '2026-1', '2026-10-15', 'abc', '', undefined, null]) {
      expect(parseMonthParam(bad as string | undefined)).toBeNull();
    }
  });
});

describe('monthIndexIn and covers', () => {
  it('numbers the months of an October budget 1..12 across the year boundary', () => {
    const b = budget('a', '2026-10-01');
    expect(monthIndexIn(b, '2026-10-01')).toBe(1);
    expect(monthIndexIn(b, '2026-12-01')).toBe(3);
    expect(monthIndexIn(b, '2027-01-01')).toBe(4);
    expect(monthIndexIn(b, '2027-09-01')).toBe(12);
    expect(monthIndexIn(b, '2027-10-01')).toBeNull();
    expect(monthIndexIn(b, '2026-09-01')).toBeNull();
    expect(covers(b, '2027-09-15')).toBe(true);
  });

  it('numbers a January budget by calendar month', () => {
    const b = budget('a', '2026-01-01');
    expect(monthIndexIn(b, '2026-01-01')).toBe(1);
    expect(monthIndexIn(b, '2026-12-01')).toBe(12);
    expect(monthIndexIn(b, '2027-01-01')).toBeNull();
    expect(nextStart(b)).toBe('2027-01-01');
  });
});

describe('pickBudget', () => {
  it('returns the active budget that covers the month, or null', () => {
    const budgets = [budget('b', '2026-10-01'), budget('a', '2025-10-01')];
    expect(pickBudget(budgets, '2026-03-01')?.id).toBe('a');
    expect(pickBudget(budgets, '2026-11-01')?.id).toBe('b');
    expect(pickBudget(budgets, '2028-01-01')).toBeNull();
  });

  it('takes the latest start when two budgets overlap', () => {
    const budgets = [budget('jan', '2026-01-01'), budget('oct', '2025-10-01')];
    // Both cover March 2026; the January budget starts later.
    expect(pickBudget(budgets, '2026-03-01')?.id).toBe('jan');
    expect(pickBudget(budgets, '2025-11-01')?.id).toBe('oct');
  });

  it('ignores archived budgets unless one is pinned', () => {
    const budgets = [budget('arch', '2026-10-01', 'archived'), budget('old', '2025-10-01')];
    expect(pickBudget(budgets, '2026-11-01')).toBeNull();
    expect(pickBudget(budgets, '2026-11-01', 'arch')?.id).toBe('arch');
    expect(pickBudget(budgets, '2026-11-01', 'missing')).toBeNull();
  });
});

describe('nearest covered month, default month and month state', () => {
  const budgets = [budget('a', '2025-10-01'), budget('x', '2024-10-01', 'archived')];
  it('finds the closest month an active budget covers', () => {
    expect(nearestCoveredMonth(budgets, '2026-11-01')).toBe('2026-09-01');
    expect(nearestCoveredMonth(budgets, '2025-05-01')).toBe('2025-10-01');
    expect(nearestCoveredMonth(budgets, '2026-03-01')).toBe('2026-03-01');
    expect(nearestCoveredMonth([], '2026-03-01')).toBeNull();
  });

  it('opens today when covered, else the nearest end of the budget', () => {
    const b = budget('a', '2025-10-01');
    expect(defaultMonth(b, '2026-03-14')).toBe('2026-03-01');
    expect(defaultMonth(b, '2027-02-02')).toBe('2026-09-01');
    expect(defaultMonth(b, '2025-01-02')).toBe('2025-10-01');
  });

  it('classifies months against today', () => {
    expect(monthState('2026-09-01', '2026-10-01')).toBe('past');
    expect(monthState('2026-10-01', '2026-10-14')).toBe('current');
    expect(monthState('2026-11-01', '2026-10-01')).toBe('future');
    expect(monthsBetween('2026-10-01', '2025-10-01')).toBe(-12);
  });
});

describe('paceFraction', () => {
  it('is day over days in the current month only', () => {
    expect(paceFraction('2026-10-15', '2026-10-01')).toBeCloseTo(15 / 31);
    expect(paceFraction('2026-10-31', '2026-10-01')).toBe(1);
    expect(paceFraction('2026-10-15', '2026-09-01')).toBeNull();
  });
});
