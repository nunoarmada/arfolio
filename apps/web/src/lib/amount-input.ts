import { AmountParseError, parseAmount } from '@arfolio/core';

export type PlannedParse =
  { ok: true; minor: number } | { ok: false; reason: 'invalid' | 'negative' };

/** A planned monthly amount typed by the user: empty is zero; comma or dot decimals, dot or space groups. */
export function parsePlanned(raw: string): PlannedParse {
  const text = raw.trim();
  if (text === '') return { ok: true, minor: 0 };
  try {
    const minor = parseAmount(text);
    return minor < 0 ? { ok: false, reason: 'negative' } : { ok: true, minor };
  } catch (error) {
    if (error instanceof AmountParseError) return { ok: false, reason: 'invalid' };
    throw error;
  }
}

/** A valid typed amount rewritten the way the locale types it (blur formatting); null when invalid. */
export function tidyPlannedInput(raw: string, locale: string): string | null {
  const parsed = parsePlanned(raw);
  return parsed.ok ? toPlannedInput(parsed.minor, locale) : null;
}

/** Minor units as an editable string in the locale's decimal style ("1200,5" is "1200,50"); zero is empty. */
export function toPlannedInput(minor: number, locale: string): string {
  if (minor === 0) return '';
  const sep =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ??
    '.';
  const whole = Math.trunc(minor / 100);
  const cents = minor % 100;
  return cents === 0 ? String(whole) : `${whole}${sep}${String(cents).padStart(2, '0')}`;
}
