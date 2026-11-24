import { AmountParseError, parseAmount } from '@arfolio/core';

export type PlannedParse =
  { ok: true; minor: number } | { ok: false; reason: 'invalid' | 'negative' };

/**
 * A planned monthly amount typed by the user: empty is zero; comma or dot decimals, dot or space
 * groups. `minorDigits` is the currency's (`minorDigits` in core: 0 for JPY, 3 for KWD; default 2);
 * the result is in its minor units.
 */
export function parsePlanned(raw: string, minorDigits = 2): PlannedParse {
  const text = raw.trim();
  if (text === '') return { ok: true, minor: 0 };
  try {
    const minor = parseAmount(text, { minorDigits });
    return minor < 0 ? { ok: false, reason: 'negative' } : { ok: true, minor };
  } catch (error) {
    if (error instanceof AmountParseError) return { ok: false, reason: 'invalid' };
    throw error;
  }
}

/** A valid typed amount rewritten the way the locale types it (blur formatting); null when invalid. */
export function tidyPlannedInput(raw: string, locale: string, minorDigits = 2): string | null {
  const parsed = parsePlanned(raw, minorDigits);
  return parsed.ok ? toPlannedInput(parsed.minor, locale, minorDigits) : null;
}

/**
 * Minor units (of a currency with `minorDigits`, default 2) as an editable string in the locale's
 * decimal style ("1200,5" is "1200,50"; whole amounts have no decimals); zero is empty.
 */
export function toPlannedInput(minor: number, locale: string, minorDigits = 2): string {
  if (minor === 0) return '';
  const sep =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ??
    '.';
  const scale = 10 ** minorDigits;
  const whole = Math.trunc(minor / scale);
  const fraction = Math.abs(minor % scale);
  return fraction === 0
    ? String(whole)
    : `${whole}${sep}${String(fraction).padStart(minorDigits, '0')}`;
}
