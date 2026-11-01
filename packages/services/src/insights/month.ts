/** `yyyy-mm` or the first-of-month date `yyyy-mm-01`, the two forms a caller passes a month in. */
export const MONTH_INPUT = /^\d{4}-(0[1-9]|1[0-2])(-01)?$/;

/** The `yyyy-mm` of a validated month input. */
export const monthKey = (input: string): string => input.slice(0, 7);

export function addMonths(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export const firstDay = (month: string): string => `${month}-01`;

export function lastDay(month: string): string {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return `${month}-${String(last.getUTCDate()).padStart(2, '0')}`;
}
