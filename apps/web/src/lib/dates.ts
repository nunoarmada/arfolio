/**
 * Calendar-date helpers. Booking dates are plain `YYYY-MM-DD` strings (no time, no zone), so all
 * arithmetic happens on UTC midnights; only "today" depends on the household time zone.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtc(iso: string): Date {
  const m = ISO.exec(iso);
  if (!m) throw new RangeError(`Not an ISO date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Today's date in `timeZone` as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(iso: string, days: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
  const d = toUtc(monthStart(iso));
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const d = toUtc(monthStart(iso));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function dayDifference(a: string, b: string): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86_400_000);
}

const fmt = (locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });

/** A table/detail date in the household locale (e.g. 14/10/2026). */
export function formatDate(iso: string, locale: string): string {
  return fmt(locale, { dateStyle: 'medium' }).format(toUtc(iso));
}

/** Month and year ("outubro de 2026"). */
export function formatMonth(iso: string, locale: string): string {
  return fmt(locale, { month: 'long', year: 'numeric' }).format(toUtc(iso));
}

export function monthName(iso: string, locale: string): string {
  return fmt(locale, { month: 'long' }).format(toUtc(iso));
}

/** Short date without year ("14 out."). */
export function formatShortDay(iso: string, locale: string): string {
  return fmt(locale, { day: 'numeric', month: 'short' }).format(toUtc(iso));
}

/**
 * Day-group heading: the translated "today"/"yesterday", else weekday + day + month, with the
 * year added for dates outside the current year.
 */
export function dayHeading(
  iso: string,
  today: string,
  locale: string,
  labels: { today: string; yesterday: string },
): string {
  if (iso === today) return labels.today;
  if (iso === addDays(today, -1)) return labels.yesterday;
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  // One formatter, so the order of weekday, day and month follows the locale.
  return fmt(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(toUtc(iso));
}

/** Full timestamp for "Alex, 14 Oct" style provenance lines. */
export function formatDateTime(value: Date | string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

/** Short month and year as in the sheet: "out. 26" (or "out. 2026" with `fullYear`). */
export function formatMonthShort(iso: string, locale: string, fullYear = false): string {
  const month = fmt(locale, { month: 'short' }).format(toUtc(iso));
  const year = fmt(locale, { year: fullYear ? 'numeric' : '2-digit' }).format(toUtc(iso));
  return `${month} ${year}`;
}
