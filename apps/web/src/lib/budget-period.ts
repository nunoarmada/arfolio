import { addMonths, formatMonth, monthEnd, monthStart } from './dates';

/** The fields of a budget the period helpers need (a service `Budget` is assignable to it). */
export interface BudgetRef {
  id: string;
  startMonth: string;
  name: string;
  status: 'active' | 'archived';
}

export type MonthState = 'past' | 'current' | 'future';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/;

/** `yyyy-mm` or `yyyy-mm-01` from a query string as `yyyy-mm-01`; anything else is null. */
export function parseMonthParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = MONTH.exec(raw);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

/** `yyyy-mm` of a month key or date, the form used in URLs. */
export function monthParam(month: string): string {
  return month.slice(0, 7);
}

/** Whole months from `from` to `to` (both first-of-month dates); negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/** The first month of the next budget year. */
export function nextStart(budget: Pick<BudgetRef, 'startMonth'>): string {
  return addMonths(budget.startMonth, 12);
}

/** The last month (first day) a budget covers. */
export function lastMonth(budget: Pick<BudgetRef, 'startMonth'>): string {
  return addMonths(budget.startMonth, 11);
}

export function covers(budget: Pick<BudgetRef, 'startMonth'>, month: string): boolean {
  const offset = monthsBetween(budget.startMonth, monthStart(month));
  return offset >= 0 && offset <= 11;
}

/** 1..12 for a month inside the budget, else null. */
export function monthIndexIn(budget: Pick<BudgetRef, 'startMonth'>, month: string): number | null {
  const offset = monthsBetween(budget.startMonth, monthStart(month));
  return offset >= 0 && offset <= 11 ? offset + 1 : null;
}

/** The month key (first day) of month `index` (1..12) of the budget. */
export function monthAt(budget: Pick<BudgetRef, 'startMonth'>, index: number): string {
  return addMonths(budget.startMonth, index - 1);
}

/**
 * The budget that answers for `month`. A pinned budget (opened from the budgets list, archived or
 * not) wins; otherwise only active budgets count, and when two overlap (the fiscal start changed
 * after budgets existed) the one that starts last.
 */
export function pickBudget<B extends BudgetRef>(
  budgets: readonly B[],
  month: string,
  pinnedId?: string | null,
): B | null {
  if (pinnedId) return budgets.find((b) => b.id === pinnedId) ?? null;
  let best: B | null = null;
  for (const b of budgets) {
    if (b.status !== 'active' || !covers(b, month)) continue;
    if (!best || b.startMonth > best.startMonth) best = b;
  }
  return best;
}

/** The active budgets from the newest start to the oldest. */
export function activeBudgets<B extends BudgetRef>(budgets: readonly B[]): B[] {
  return budgets
    .filter((b) => b.status === 'active')
    .sort((a, b) => b.startMonth.localeCompare(a.startMonth));
}

/** The month of an active budget closest to `month` (for "go to the nearest covered month"). */
export function nearestCoveredMonth(budgets: readonly BudgetRef[], month: string): string | null {
  let best: { month: string; distance: number } | null = null;
  for (const b of budgets) {
    if (b.status !== 'active') continue;
    const first = b.startMonth;
    const last = lastMonth(b);
    const target = month < first ? first : month > last ? last : month;
    const distance = Math.abs(monthsBetween(month, target));
    if (!best || distance < best.distance) best = { month: target, distance };
  }
  return best?.month ?? null;
}

export function monthState(month: string, todayMonth: string): MonthState {
  const offset = monthsBetween(monthStart(todayMonth), monthStart(month));
  return offset < 0 ? 'past' : offset === 0 ? 'current' : 'future';
}

/** How far through the month `today` is (day / days), or null when `today` is not in the month. */
export function paceFraction(today: string, month: string): number | null {
  if (monthStart(today) !== monthStart(month)) return null;
  const day = Number(today.slice(8, 10));
  const days = Number(monthEnd(month).slice(8, 10));
  return day / days;
}

/** The month shown first: today's month when the budget covers it, else the nearest end. */
export function defaultMonth(budget: Pick<BudgetRef, 'startMonth'>, today: string): string {
  const current = monthStart(today);
  if (covers(budget, current)) return current;
  return current < budget.startMonth ? budget.startMonth : lastMonth(budget);
}

/** Days after the expected date before a missing recurring payment counts as overdue. */
export const OVERDUE_GRACE_DAYS = 5;

/** "outubro de 2026 – setembro de 2027" for the budget year starting at `start`. */
export function formatBudgetRange(start: string, locale: string): string {
  return `${formatMonth(start, locale)} – ${formatMonth(addMonths(start, 11), locale)}`;
}
