import { minorDigits } from '@arfolio/core';

/** An amount a tool received is not a plain decimal for the currency (the message is English). */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

/** Money as tools return it: a decimal string, the same in minor units (a string), and the currency. */
export type MoneyOut = { amount: string; amount_minor: string; currency: string };

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Parses a tool amount into signed integer minor units. Only `-?digits` with at most the currency's
 * minor digits after a `.` is accepted: no thousands separators, comma decimals, exponents, signs
 * other than `-`, symbols or spaces. Unlike the import parser (`parseAmount`), nothing is guessed
 * or rounded: `"12,34"`, `"1e3"` and `"0.001"` (for EUR) are rejected.
 */
export function parseMoneyInput(text: string, currency: string): number {
  if (!CURRENCY.test(currency)) throw new InvalidAmountError('Invalid currency code');
  const digits = minorDigits(currency);
  const pattern = new RegExp(`^-?\\d+(\\.\\d{1,${Math.max(digits, 1)}})?$`);
  const decimals = /\.(\d+)$/.exec(text)?.[1] ?? '';
  if (!pattern.test(text) || decimals.length > digits) {
    throw new InvalidAmountError(
      digits === 0
        ? `Expected a whole number in ${currency}, like "12" or "-12"`
        : `Expected a decimal like "12.34" or "-12.34" with at most ${digits} decimals for ${currency}`,
    );
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const minor = BigInt(whole + fraction.padEnd(digits, '0'));
  const signed = negative ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new InvalidAmountError('Amount is too large');
  }
  return Number(signed);
}

/** Formats minor units exactly (BigInt string maths, never a float). */
export function formatMoney(minor: number | bigint, currency: string): MoneyOut {
  const digits = minorDigits(currency);
  const value = BigInt(minor);
  const abs = (value < 0n ? -value : value).toString().padStart(digits + 1, '0');
  const amount =
    digits === 0 ? abs : `${abs.slice(0, abs.length - digits)}.${abs.slice(abs.length - digits)}`;
  return {
    amount: value < 0n ? `-${amount}` : amount,
    amount_minor: value.toString(),
    currency,
  };
}
