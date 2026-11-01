/** Date wording for the net worth screens. All dates are plain `yyyy-mm-dd` strings (UTC maths). */

const utc = (iso: string): Date =>
  new Date(
    Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))),
  );

const fmt = (locale: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });

/** Day, month and year in the locale's own style (numeric in pt-PT, "30 Sep 2026" in en). */
export function formatDayYear(iso: string, locale: string): string {
  return fmt(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(utc(iso));
}

/** The short month on its own ("out."). */
export function formatMonthOnly(iso: string, locale: string): string {
  return fmt(locale, { month: 'short' }).format(utc(iso));
}

/** The short month with a two-digit year ("jan. 26"). */
export function formatMonthYear(iso: string, locale: string): string {
  return `${formatMonthOnly(iso, locale)} ${fmt(locale, { year: '2-digit' }).format(utc(iso))}`;
}

/** The month's full name ("setembro"), with the year when it is not `reference`'s year. */
export function formatMonthRelative(iso: string, reference: string, locale: string): string {
  const name = fmt(locale, { month: 'long' }).format(utc(iso));
  return iso.slice(0, 4) === reference.slice(0, 4)
    ? name
    : `${name} ${fmt(locale, { year: 'numeric' }).format(utc(iso))}`;
}

/** "Outubro de 2026" with the first letter capitalised, for a readout line. */
export function formatMonthTitle(iso: string, locale: string): string {
  const text = fmt(locale, { month: 'long', year: 'numeric' }).format(utc(iso));
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** A month list in words ("março e abril de 2026" style, one `formatMonth` each). */
export function formatList(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}
