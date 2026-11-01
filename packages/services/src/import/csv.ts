import { parse } from 'csv-parse/sync';
import { ValidationError } from '../context.js';
import { MAX_IMPORT_ROWS } from './types.js';

const DELIMITERS = [',', ';', '\t', '|'] as const;
const SAMPLE_LINES = 30;

/** UTF-8 (a BOM is dropped) when the bytes are valid UTF-8, otherwise windows-1252 (latin1 family). */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Picks the delimiter that splits the leading lines most consistently: the one whose most
 * common per-line count (outside quotes) covers the most lines, weighted by that count. Decimal
 * commas in a `;` file therefore lose against the real delimiter.
 */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, SAMPLE_LINES)
    .map((l) => l.replace(/"[^"]*"/g, ''));
  let best: string = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const frequency = new Map<number, number>();
    for (const line of lines) {
      const count = line.split(d).length - 1;
      if (count > 0) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    }
    let score = 0;
    for (const [count, lineCount] of frequency) score = Math.max(score, count * lineCount);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Reads CSV text into rows of raw cells; blank lines come through as blank rows. */
export function parseCsv(buf: Buffer): string[][] {
  const text = decodeText(buf);
  let rows: string[][];
  try {
    rows = parse(text, {
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      skip_empty_lines: false,
      // One more than the limit is enough to tell the file is too long.
      to: MAX_IMPORT_ROWS + 1,
    }) as string[][];
  } catch (error) {
    throw new ValidationError(
      `Could not read the CSV file (${error instanceof Error ? error.message : 'invalid format'})`,
    );
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError(`The file has too many rows (maximum ${MAX_IMPORT_ROWS} rows)`);
  }
  return rows;
}
