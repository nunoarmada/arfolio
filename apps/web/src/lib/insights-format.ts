/** Wording of Análises: the period in words, shares and signed amounts. Pure, locale-aware. */
import { formatMonthOnly, formatMonthRelative, formatMonthTitle } from './net-worth-format';
import type { FormatMoney } from './money-privacy';

const MINUS = '−';

const capitalise = (s: string, locale: string): string =>
  s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

const yearOf = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso.slice(0, 7)}-01T00:00:00Z`),
  );

/**
 * The stepper's label for a period of several months: "Ago.–out. 2026" inside one year,
 * "Nov. 2025–out. 2026" across two.
 */
export function rangeLabel(months: readonly string[], locale: string): string {
  const first = months[0]!;
  const last = months.at(-1)!;
  const start = capitalise(formatMonthOnly(first, locale), locale);
  const end = formatMonthOnly(last, locale);
  return yearOf(first, locale) === yearOf(last, locale)
    ? `${start}–${end} ${yearOf(last, locale)}`
    : `${start} ${yearOf(first, locale)}–${end} ${yearOf(last, locale)}`;
}

/** A month's name for a sentence ("outubro"), with the year when it is not `reference`'s year. */
export function periodMonthName(iso: string, reference: string, locale: string): string {
  if (iso.slice(0, 4) === reference.slice(0, 4)) return formatMonthRelative(iso, reference, locale);
  // Another year reads "junho de 2018", the locale's own phrase, not "junho 2018".
  return formatMonthTitle(iso, locale).toLocaleLowerCase(locale);
}

/** The period in words for a sentence: one month, or the first and last month of several. */
export type PeriodWords = { single: string } | { from: string; to: string };

export function periodWords(
  months: readonly string[],
  reference: string,
  locale: string,
): PeriodWords {
  const first = periodMonthName(months[0]!, reference, locale);
  if (months.length === 1) return { single: first };
  return { from: first, to: periodMonthName(months.at(-1)!, reference, locale) };
}

/** A share in basis points as a whole percent; anything above 0 and below 1% reads "<1%". */
export function formatBps(bps: number, locale: string): string {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  if (bps > 0 && bps < 100) return `<${percent.format(0.01)}`;
  return percent.format(bps / 10_000);
}

/** An amount with U+2212 for a negative and, when asked, an explicit plus for a positive. */
export function signedMoney(
  formatMoney: FormatMoney,
  minor: number,
  currency: string,
  locale: string,
  { plus = false }: { plus?: boolean } = {},
): string {
  const text = formatMoney(Math.abs(minor), currency, locale);
  if (minor < 0) return `${MINUS}${text}`;
  return plus && minor > 0 ? `+${text}` : text;
}
