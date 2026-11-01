import { formatMoney } from '@arfolio/core';

/** The shared money formatter's shape; privacy mode swaps the implementation, never the signature. */
export type FormatMoney = typeof formatMoney;

/** What replaces the digits of an amount in privacy mode. Fixed width, so it hides magnitude too. */
export const MONEY_MASK = '••••';

const NUMERIC = new Set(['integer', 'group', 'decimal', 'fraction']);

/**
 * A masked amount for the currency, with the symbol where the locale puts it ("•••• €" in pt-PT,
 * "€••••" in en). Built from Intl parts so the symbol position and spacing are never hand-coded.
 */
export function maskMoney(currency: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(1);
  let masked = false;
  let out = '';
  for (const part of parts) {
    if (NUMERIC.has(part.type)) {
      if (!masked) out += MONEY_MASK;
      masked = true;
    } else {
      out += part.value;
    }
  }
  return out;
}

const masked: FormatMoney = (_minor, currency, locale) => maskMoney(currency, locale);

/** The money formatter for the current privacy setting. */
export function formatMoneyFor(hidden: boolean): FormatMoney {
  return hidden ? masked : formatMoney;
}
