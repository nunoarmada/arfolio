import { minorDigits } from '@arfolio/core';

// The tool amount parser lives in core (the advisor shares it); re-exported so MCP imports stay.
export { InvalidAmountError, parseMoneyInput } from '@arfolio/core';

/** Money as tools return it: a decimal string, the same in minor units (a string), and the currency. */
export type MoneyOut = { amount: string; amount_minor: string; currency: string };

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
