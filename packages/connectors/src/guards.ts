import { ProviderResponseError } from './types.js';

/** Small defensive readers for untrusted provider JSON. Errors never echo payload values. */

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): Json {
  if (!isRecord(value))
    throw new ProviderResponseError(`Unexpected response: ${what} is not an object`);
  return value;
}

export function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value))
    throw new ProviderResponseError(`Unexpected response: ${what} is not a list`);
  return value;
}

/** Non-empty string, or undefined for null/absent/blank values. */
export function optString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function reqString(value: unknown, what: string): string {
  const s = optString(value);
  if (s === undefined) throw new ProviderResponseError(`Unexpected response: ${what} is missing`);
  return s;
}

/** `YYYY-MM-DD` from a date or date-time string, or undefined. */
export function optIsoDate(value: unknown): string | undefined {
  const s = optString(value);
  return s !== undefined && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(s) ? s.slice(0, 10) : undefined;
}

/** ISO 4217 minor-unit digits (2 for EUR, 0 for JPY, 3 for KWD): same source as core's formatMoney. */
export function currencyExponent(currency: string): number {
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw new ProviderResponseError('Unexpected response: currency code is invalid');
  }
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    throw new ProviderResponseError('Unexpected response: currency code is invalid');
  }
}

/**
 * Strict decimal string (`"12.34"`) to signed integer minor units of `currency`, by string
 * arithmetic (no floats). Trailing zeros beyond the exponent are tolerated; other excess digits
 * are rejected rather than rounded.
 */
export function minorFromDecimalString(value: unknown, currency: string, what: string): number {
  const exponent = currencyExponent(currency);
  const match = typeof value === 'string' ? /^([+-])?(\d+)(?:\.(\d+))?$/.exec(value.trim()) : null;
  if (!match) throw new ProviderResponseError(`Unexpected response: ${what} is not a valid amount`);
  const [, sign, intPart = '', fracPart = ''] = match;
  const kept = fracPart.slice(0, exponent).padEnd(exponent, '0');
  if (/[^0]/.test(fracPart.slice(exponent))) {
    throw new ProviderResponseError(
      `Unexpected response: ${what} has more decimals than the currency allows`,
    );
  }
  const minor = Number(`${intPart}${kept}`);
  if (!Number.isSafeInteger(minor)) {
    throw new ProviderResponseError(`Unexpected response: ${what} is out of range`);
  }
  return sign === '-' && minor !== 0 ? -minor : minor;
}

/**
 * JSON number to minor units. Trading 212 sends money as JSON floats (e.g. 0.30000000000000004),
 * so the value is deliberately rounded to the currency exponent first (`toFixed`) and then parsed
 * exactly; the strict decimal-string path used for Enable Banking would reject that float noise.
 * A value with real extra precision (e.g. 12.345 in EUR) is rounded as well; that is accepted
 * here because the broker reports amounts in the account currency, not exact decimals.
 */
export function minorFromNumber(value: unknown, currency: string, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProviderResponseError(`Unexpected response: ${what} is not a number`);
  }
  return minorFromDecimalString(value.toFixed(currencyExponent(currency)), currency, what);
}
