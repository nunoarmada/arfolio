import { monthEnd, monthStart } from './dates';

/** How far through the month today is, set against how much of the plan is spent. */
export interface PaceSummary {
  /** Day of the month today is (1-based) and how many days the month has. */
  day: number;
  days: number;
  /** Spent over planned, 0 and up (above 1 when over the plan). */
  spent: number;
  /** Day over days, 0..1: where the pace tick sits on the bar. */
  elapsed: number;
}

/**
 * The numbers behind "Hoje: dia 23 de 31 · 78% do previsto gasto em 74% do mês". Null when the
 * month is not the current one or nothing is planned (a share of nothing is not a number), so
 * the sentence is simply left out.
 */
export function paceSummary(
  today: string,
  month: string,
  planned: number,
  actual: number,
): PaceSummary | null {
  if (monthStart(today) !== monthStart(month) || planned <= 0) return null;
  const day = Number(today.slice(8, 10));
  const days = Number(monthEnd(month).slice(8, 10));
  return { day, days, spent: Math.max(actual, 0) / planned, elapsed: day / days };
}

/** A share as a whole percent in the locale; anything above zero but under 1% reads "<1%". */
export function formatShare(fraction: number, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  if (fraction > 0 && fraction < 0.01) return `<${format.format(0.01)}`;
  // Rounding must not claim a full plan (or month) that is not reached yet.
  if (fraction < 1 && Math.round(fraction * 100) >= 100) return format.format(0.99);
  return format.format(fraction);
}
