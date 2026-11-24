/**
 * Amount parsing: string -> signed integer minor units of the currency, never via floats.
 * `minorDigits` is the currency's ISO 4217 exponent (`minorDigits(currency)` in money.ts: 2 for
 * EUR, 0 for JPY, 3 for KWD); it defaults to 2.
 */
export class AmountParseError extends Error {
  constructor(input: string) {
    super(`Cannot parse amount: ${JSON.stringify(input)}`);
    this.name = 'AmountParseError';
  }
}

const CURRENCY_SYMBOLS = /[€$£¥]/g;
const CURRENCY_CODE = /\b[A-Za-z]{3}\b/g;
const GROUP_SEPARATORS = /[\s\u00a0\u202f']/g;

export type ParseAmountOptions = {
  /** The decimal separator; detected from the text when omitted (see `detectDecimal`). */
  decimal?: ',' | '.';
  /** Minor-unit digits of the currency (0-4); the result is in those minor units. Default 2. */
  minorDigits?: number;
};

const MAX_MINOR_DIGITS = 4;

export function parseAmount(input: string, opts: ParseAmountOptions = {}): number {
  const digits = opts.minorDigits ?? 2;
  if (!Number.isInteger(digits) || digits < 0 || digits > MAX_MINOR_DIGITS) {
    throw new RangeError(
      `parseAmount: minorDigits must be an integer from 0 to ${MAX_MINOR_DIGITS}`,
    );
  }
  let s = input.replace(CURRENCY_SYMBOLS, '').replace(CURRENCY_CODE, '').trim();
  let negative = false;

  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('-') || s.startsWith('+')) {
    negative = negative !== (s[0] === '-');
    s = s.slice(1).trim();
  }
  if (s.endsWith('-') || s.endsWith('+')) {
    negative = negative !== s.endsWith('-');
    s = s.slice(0, -1).trim();
  }

  s = s.replace(GROUP_SEPARATORS, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) throw new AmountParseError(input);

  const decimal = opts.decimal ?? detectDecimal(s, digits);
  let intPart = s;
  let fracPart = '';
  if (decimal) {
    const idx = s.lastIndexOf(decimal);
    if (idx >= 0) {
      intPart = s.slice(0, idx);
      fracPart = s.slice(idx + 1);
    }
  }
  // Once a thousands separator appears, the first group has 1-3 digits and the rest exactly 3.
  if (!/^(?:\d{1,3}(?:[.,]\d{3})+|\d*)$/.test(intPart)) throw new AmountParseError(input);
  intPart = intPart.replace(/[.,]/g, '');
  // Decimals beyond the currency's are accepted only as trailing zeros ("1234.00" in JPY).
  const kept = fracPart.slice(0, digits);
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || /[1-9]/.test(fracPart.slice(digits))) {
    throw new AmountParseError(input);
  }
  if (intPart === '' && fracPart === '') throw new AmountParseError(input);

  const minor = Number(`${intPart || '0'}${kept.padEnd(digits, '0')}`);
  if (!Number.isSafeInteger(minor)) throw new AmountParseError(input);
  return negative && minor !== 0 ? -minor : minor;
}

/**
 * Decimal separator is the last `,`/`.` when it appears once and is followed by 1-2 digits, or
 * 1-3 digits for a three-decimal currency: "1.234" is 1234 in EUR or JPY but 1.234 in KWD.
 */
function detectDecimal(s: string, digits: number): ',' | '.' | null {
  const idx = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (idx < 0) return null;
  const sep = s[idx] as ',' | '.';
  const trailing = s.length - idx - 1;
  if (trailing < 1 || trailing > Math.max(digits, 2)) return null;
  const occurrences = s.split(sep).length - 1;
  return occurrences === 1 ? sep : null;
}
