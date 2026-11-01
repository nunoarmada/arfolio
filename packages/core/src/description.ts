import { foldText } from './fold';

/**
 * Default leading noise words (PT) stripped from bank descriptions. Kept as one
 * exported constant so locales can extend it later. Longest entries first.
 */
export const NOISE_PREFIXES: readonly string[] = [
  'MB WAY',
  'CONTACTLESS',
  'PAGAMENTO',
  'CARTAO',
  'COMPRA',
  'TRF',
  'DD',
];

// Full masks (1234 **** 5678) must be tried before the trailing-digits form (****5678).
const CARD_MASKS = [/\d{4}\s*\*+\s*\d{4}/g, /\*{2,}\s*\d{4}/g];
// Only date-like tokens: dd/mm, dd/mm/yy(yy), dd.mm.yyyy, yyyy-mm-dd. A bare `2.5` is a quantity.
const DATES =
  /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}[.-]\d{1,2}[.-]\d{2,4})\b/g;
const LONG_DIGITS = /\d{6,}/g;

export function normalizeDescription(raw: string): string {
  let s = foldText(raw);
  for (const mask of CARD_MASKS) s = s.replace(mask, ' ');
  s = s.replace(DATES, ' ').replace(LONG_DIGITS, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  for (let stripped = true; stripped;) {
    stripped = false;
    for (const prefix of NOISE_PREFIXES) {
      if (s === prefix || s.startsWith(prefix + ' ')) {
        s = s.slice(prefix.length).trim();
        stripped = true;
      }
    }
  }
  return s;
}

/** Stable merchant key: the normalised counterparty when present, else the description. */
export function merchantKey(raw: string, counterparty?: string | null): string {
  const fromCounterparty = counterparty ? normalizeDescription(counterparty) : '';
  return fromCounterparty || normalizeDescription(raw);
}
