export type BudgetMonth = { index: number; from: string; to: string };

const START = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether the runtime knows this IANA timezone (the household setting is free text). */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function assertTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw new RangeError(`Unknown timezone: ${timezone}`);
}

/**
 * The 12 months of the budget year that starts on `startMonth` (`yyyy-mm-01`), as inclusive local
 * date ranges. `purchase_date` is already a local calendar date in the household's timezone, so
 * month membership is a plain date comparison and DST never moves a boundary; the timezone is
 * validated here so a bad household setting fails loudly instead of silently being ignored.
 */
export function budgetMonths(startMonth: string, timezone: string): BudgetMonth[] {
  assertTimezone(timezone);
  const m = START.exec(startMonth);
  if (!m) throw new RangeError(`Invalid budget start month: ${startMonth}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12) throw new RangeError(`Invalid budget start month: ${startMonth}`);
  if (day !== 1)
    throw new RangeError(`Budget start must be the first day of a month: ${startMonth}`);

  return Array.from({ length: 12 }, (_, i) => {
    const total = year * 12 + (month - 1) + i;
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return {
      index: i + 1,
      from: `${pad(y, 4)}-${pad(mo)}-01`,
      to: `${pad(y, 4)}-${pad(mo)}-${pad(daysInMonth(y, mo))}`,
    };
  });
}

/** The start month (`yyyy-mm-01`) of the budget year that contains the local date `date`. */
export function budgetStartFor(date: string, fiscalYearStartMonth: number): string {
  const m = START.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  const [year, month] = [Number(m[1]), Number(m[2])];
  const startYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${pad(startYear, 4)}-${pad(fiscalYearStartMonth)}-01`;
}
