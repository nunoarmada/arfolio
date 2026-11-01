/** Date helpers on `YYYY-MM-DD` strings, in UTC (no time zone is involved). */

export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

export function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** Whole months from `from` to `to` (first-of-month dates). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * The active budget covering `month` (a budget spans the 12 months from its start); when two
 * overlap, the one that starts last. Same rule as the web app's month view.
 */
export function pickBudget<B extends { startMonth: string; status: string }>(
  budgets: readonly B[],
  month: string,
): { budget: B; monthIndex: number } | null {
  let best: { budget: B; monthIndex: number } | null = null;
  for (const budget of budgets) {
    if (budget.status !== 'active') continue;
    const offset = monthsBetween(budget.startMonth, monthStart(month));
    if (offset < 0 || offset > 11) continue;
    if (!best || budget.startMonth > best.budget.startMonth) {
      best = { budget, monthIndex: offset + 1 };
    }
  }
  return best;
}
