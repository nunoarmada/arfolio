import { minorDigits } from '@arfolio/core';
import { dayDifference } from './dates';
import { MONEY_MASK } from './money-privacy';

const MINUS = '−';

/** An exact decimal string from the services ("-1234.56") as integer minor units of the currency. */
export function decimalToMinor(value: string, currency: string): number {
  const digits = minorDigits(currency);
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^[-+]/, '').split('.');
  const padded = (fraction + '0'.repeat(digits)).slice(0, digits);
  const minor = Number(`${whole}${padded}`);
  return negative && minor !== 0 ? -minor : minor;
}

/** Basis points as a percentage with one decimal ("41,2 %"); `signed` adds + or − (none at zero). */
export function formatBps(bps: number, locale: string, signed = false): string {
  const text = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
  }).format(bps / 10_000);
  return text.replace('-', MINUS);
}

/** A quantity with at most 6 decimals and no trailing zeros. */
export function formatQuantity(value: string, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(Number(value));
}

/** `formatQuantity` for the privacy setting: quantity × a public price is the position's value. */
export function formatQuantityFor(hidden: boolean): typeof formatQuantity {
  return hidden ? () => MONEY_MASK : formatQuantity;
}

export type GainSign = 'gain' | 'loss' | 'flat';

export const gainSign = (minor: number): GainSign =>
  minor > 0 ? 'gain' : minor < 0 ? 'loss' : 'flat';

/** Signed amount for a gain or loss ("+120,40 €", "−35,00 €"); zero has no sign. */
export function signedAmount(minor: number, text: string): string {
  return `${minor > 0 ? '+' : minor < 0 ? MINUS : ''}${text}`;
}

/** The snapshot is stale when it is more than 3 days older than today. */
export function isStale(asOf: string, today: string): boolean {
  return dayDifference(today, asOf) > 3;
}

/** `asOf` is a yyyy-mm-dd day: "14 out." this year, "14 out. 2025" otherwise. */
export function formatAsOf(asOf: string, today: string, locale: string): string {
  const sameYear = asOf.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(new Date(`${asOf}T00:00:00Z`));
}
