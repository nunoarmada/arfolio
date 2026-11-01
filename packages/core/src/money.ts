export interface FormatMoneyOptions {
  /** Short form for chart axes ("1,2 mil €", "€1.2K"): at most one decimal. */
  compact?: boolean;
}

/** Number of minor-unit digits ISO 4217 gives the currency (2 for EUR, 0 for JPY, 3 for KWD). */
export function minorDigits(currency: string, locale = 'en'): number {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * Formats an amount held in integer minor units (cents) for display.
 *
 * `useGrouping: 'always'` is deliberate: CLDR gives pt-PT a minimum grouping of two digits, so
 * plain Intl prints `1234,56 €`; the household expects `1 234,56 €`. Separators are whatever Intl
 * emits (pt-PT uses non-breaking spaces), never replaced by hand.
 *
 * The amount is converted to a number only here, at format time.
 */
export function formatMoney(
  minor: number | bigint,
  currency: string,
  locale: string,
  opts: FormatMoneyOptions = {},
): string {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new RangeError('formatMoney: minor units must be a safe integer');
  }
  const digits = minorDigits(currency, locale);
  const value = Number(minor) / 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    useGrouping: 'always',
    ...(opts.compact
      ? { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 }
      : {}),
  }).format(value);
}

/**
 * Minor units as an exact plain decimal string for the currency ("-1234.56", "1234" for JPY):
 * BigInt string maths, no grouping, no symbol, never a float. For machine-readable output.
 */
export function minorDecimal(minor: number | bigint, currency: string): string {
  if (typeof minor === 'number' && !Number.isSafeInteger(minor)) {
    throw new RangeError('minorDecimal: minor units must be a safe integer');
  }
  const digits = minorDigits(currency);
  const value = BigInt(minor);
  const abs = (value < 0n ? -value : value).toString().padStart(digits + 1, '0');
  const text =
    digits === 0 ? abs : `${abs.slice(0, abs.length - digits)}.${abs.slice(abs.length - digits)}`;
  return value < 0n ? `-${text}` : text;
}
