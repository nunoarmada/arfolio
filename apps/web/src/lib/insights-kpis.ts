import { shiftMonth } from './net-worth-chart';
import type { TrendRow } from './insights-chart';

export interface MonthKpis {
  income: number;
  expense: number;
  /** Saving as basis points of income; null when there was no income to compare with. */
  savingRateBps: number | null;
  /** Spending against the equally long period right before, when the twelve months cover it. */
  previous: { expense: number; deltaMinor: number; deltaBps: number | null } | null;
}

const sum = (rows: readonly TrendRow[], key: 'income' | 'expense' | 'saving') =>
  rows.reduce((total, r) => total + r[key], 0);

/**
 * The KPI strip of Análises, derived from the twelve-month rows the page already loads: the
 * selected months' spending and income, the share of income that went to saving, and how
 * spending moved against the period just before (null when that period is not in the rows).
 */
export function monthKpis(rows: readonly TrendRow[], months: readonly string[]): MonthKpis {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const pick = (list: readonly string[]) =>
    list.flatMap((m) => {
      const r = byMonth.get(m);
      return r ? [r] : [];
    });
  const current = pick(months);
  const income = sum(current, 'income');
  const expense = sum(current, 'expense');
  const before = months.map((m) => shiftMonth(m, -months.length));
  const prior = pick(before);
  const previous =
    prior.length === months.length
      ? (() => {
          const was = sum(prior, 'expense');
          return {
            expense: was,
            deltaMinor: expense - was,
            deltaBps: was > 0 ? Math.round(((expense - was) / was) * 10_000) : null,
          };
        })()
      : null;
  return {
    income,
    expense,
    savingRateBps: income > 0 ? Math.round((sum(current, 'saving') / income) * 10_000) : null,
    previous,
  };
}
