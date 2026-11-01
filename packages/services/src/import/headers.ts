/** Cells longer than this are cut before folding (headers are short; cells are untrusted). */
const MAX_HEADER_CHARS = 200;

/** Lower-case, accent-free, single-spaced header text without trailing dots. */
export function foldHeader(text: string): string {
  const folded = text
    .slice(0, MAX_HEADER_CHARS)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  // A loop, not a regex: `\.+$` backtracks quadratically on long runs of dots.
  let end = folded.length;
  while (end > 0 && folded[end - 1] === '.') end -= 1;
  return folded.slice(0, end).trim();
}

/** Header names (folded) we recognise, English and Portuguese. */
export const DATE_HEADERS = [
  'date',
  'data',
  'data mov',
  'data movimento',
  'data operacao',
  'data lancamento',
  'data contabilistica',
  'booking date',
  'posting date',
  'posted date',
  'transaction date',
  'started date',
];
export const VALUE_DATE_HEADERS = ['value date', 'data valor', 'completed date'];
export const DESCRIPTION_HEADERS = [
  'description',
  'descricao',
  'descritivo',
  'movimento',
  'details',
  'narrative',
  'memo',
  'reference',
];
export const AMOUNT_HEADERS = ['amount', 'montante', 'valor', 'importe'];
export const DEBIT_HEADERS = ['debit', 'debito', 'saidas'];
export const CREDIT_HEADERS = ['credit', 'credito', 'entradas'];
const OTHER_HEADERS = ['balance', 'saldo', 'type', 'state', 'currency', 'fee', 'product'];

const KNOWN = new Set([
  ...DATE_HEADERS,
  ...VALUE_DATE_HEADERS,
  ...DESCRIPTION_HEADERS,
  ...AMOUNT_HEADERS,
  ...DEBIT_HEADERS,
  ...CREDIT_HEADERS,
  ...OTHER_HEADERS,
]);

/** How many cells of a row look like known column titles. */
function headerScore(row: string[]): number {
  return row.reduce((n, cell) => (KNOWN.has(foldHeader(cell)) ? n + 1 : n), 0);
}

const HEADER_SEARCH_ROWS = 30;

/**
 * The header line is the first of the leading rows with the most known column titles (at least
 * two); title rows above it are ignored. Falls back to the first row.
 */
export function detectHeaderRow(grid: string[][]): number {
  let best = 0;
  let bestScore = 1;
  for (let i = 0; i < Math.min(grid.length, HEADER_SEARCH_ROWS); i += 1) {
    const score = headerScore(grid[i]!);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** Index of the first header whose folded text is one of `names` (earlier names win). */
export function findHeader(headers: string[], names: readonly string[]): number {
  const folded = headers.map(foldHeader);
  for (const name of names) {
    const idx = folded.indexOf(name);
    if (idx >= 0) return idx;
  }
  return -1;
}
