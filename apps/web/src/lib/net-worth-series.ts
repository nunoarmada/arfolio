import { monthsBetween, shiftMonth, type ChartRow } from './net-worth-chart';

/**
 * One record's values as monthly rows for the compact chart on a detail page: a value holds
 * until the next one, so each month shows the last value dated on or before its end; the current
 * month shows `currentAmount` (today's figure, which may be an estimate). Months before the
 * first value, and values dated after the current month, are left out.
 */
export function monthlySeries(
  entries: ReadonlyArray<{ asOf: string; amount: number }>,
  currentMonth: string,
  currentAmount: number,
): ChartRow[] {
  const sorted = entries
    .filter((e) => e.asOf.slice(0, 7) <= currentMonth.slice(0, 7))
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  const first = sorted[0];
  if (!first) return [];
  const start = `${first.asOf.slice(0, 7)}-01`;
  const out: ChartRow[] = [];
  for (let i = 0; i <= monthsBetween(start, currentMonth); i++) {
    const month = shiftMonth(start, i);
    const isCurrent = month === currentMonth;
    const value = isCurrent
      ? currentAmount
      : sorted.filter((e) => e.asOf.slice(0, 7) <= month.slice(0, 7)).at(-1)!.amount;
    const prev = out.at(-1);
    out.push({
      month,
      assets: value,
      liabilities: 0,
      net: value,
      change: prev ? value - prev.net : null,
    });
  }
  return out;
}
