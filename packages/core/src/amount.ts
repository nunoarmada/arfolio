/**
 * Amount parsing: string -> signed integer minor units, never via floats.
 * Assumes 2 decimal places; currencies with 0 or 3 decimals are out of scope.
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

export function parseAmount(input: string, opts: { decimal?: ',' | '.' } = {}): number {
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

  const decimal = opts.decimal ?? detectDecimal(s);
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
  if (!/^\d*$/.test(intPart) || !/^\d{0,2}$/.test(fracPart)) throw new AmountParseError(input);
  if (intPart === '' && fracPart === '') throw new AmountParseError(input);

  const minor = Number(intPart || '0') * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new AmountParseError(input);
  return negative && minor !== 0 ? -minor : minor;
}

/** Decimal separator is the last `,`/`.` when followed by 1-2 digits and not repeated. */
function detectDecimal(s: string): ',' | '.' | null {
  const idx = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (idx < 0) return null;
  const sep = s[idx] as ',' | '.';
  const trailing = s.length - idx - 1;
  if (trailing < 1 || trailing > 2) return null;
  const occurrences = s.split(sep).length - 1;
  return occurrences === 1 ? sep : null;
}
