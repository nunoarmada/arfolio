import { extname } from 'node:path';
import { ValidationError } from '../context.js';
import { parseCsv } from './csv.js';
import { detectHeaderRow } from './headers.js';
import { parseOfx } from './ofx.js';
import { MAX_IMPORT_BYTES, type ParsedTable, type TableKind } from './types.js';
import { parseXlsx } from './xlsx.js';

const KINDS: Record<string, TableKind> = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.xlsx': 'xlsx',
  '.ofx': 'ofx',
  '.qfx': 'ofx',
};

/**
 * Reads a statement file (CSV, XLSX or OFX) into a ParsedTable. The file is untrusted: size and
 * row limits are enforced and nothing in it is ever executed. Async because XLSX is.
 */
export async function parseFile(buf: Buffer, filename: string): Promise<ParsedTable> {
  if (buf.length === 0) throw new ValidationError('The file is empty');
  if (buf.length > MAX_IMPORT_BYTES) {
    throw new ValidationError('The file is too large (maximum 10 MB)');
  }
  const kind = KINDS[extname(filename).toLowerCase()];
  if (!kind) throw new ValidationError('Unsupported file type: use CSV, OFX or XLSX');

  if (kind === 'ofx') {
    return { kind, grid: [], headerRow: 0, headers: [], rows: [], ofx: parseOfx(buf) };
  }
  const grid = kind === 'csv' ? parseCsv(buf) : await parseXlsx(buf);
  const headerRow = detectHeaderRow(grid);
  return {
    kind,
    grid,
    headerRow,
    headers: grid[headerRow] ?? [],
    rows: grid.slice(headerRow + 1),
  };
}
