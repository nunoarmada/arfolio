import type { BudgetKind } from './budget-status';

export type YearShow = 'planned' | 'actual' | 'diff';
export const YEAR_SHOWS: readonly YearShow[] = ['planned', 'actual', 'diff'];

export function parseShow(raw: string | null | undefined): YearShow {
  return YEAR_SHOWS.find((s) => s === raw) ?? 'planned';
}

/** Integer division rounded half away from zero (display figures only). */
export function roundDiv(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** `total / months`, in minor units. */
export function monthlyAverage(total: number, months: number): number {
  return roundDiv(total, Math.max(1, months));
}

/** Share of `whole` that `part` makes, in tenths of a percent (123 = 12.3%); null when `whole` is 0. */
export function shareTenths(part: number, whole: number): number | null {
  return whole === 0 ? null : roundDiv(part * 1000, whole);
}

/** "12,3 %" style text from tenths; the locale decides the separator. */
export function formatTenths(tenths: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(tenths / 1000);
}

/** Positive means better than planned in every kind: spending less, earning or saving more. */
export function favourable(kind: BudgetKind, planned: number, actual: number): number {
  return kind === 'expense' ? planned - actual : actual - planned;
}

/** An expense month that spent more than planned (past or current months only). */
export function isOverPlan(kind: BudgetKind, planned: number, actual: number): boolean {
  return kind === 'expense' && actual > planned;
}

/** Months of the budget that have started, counting the current one: 1..12. */
export function monthsElapsed(startMonth: string, todayMonth: string): number {
  const [sy, sm] = startMonth.split('-').map(Number) as [number, number];
  const [ty, tm] = todayMonth.split('-').map(Number) as [number, number];
  return Math.min(12, Math.max(1, (ty - sy) * 12 + (tm - sm) + 1));
}
