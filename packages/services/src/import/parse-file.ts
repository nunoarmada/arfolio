import { extname } from 'node:path';
import { ValidationError } from '../context.js';
import { parseCsv } from './csv.js';
import { detectHeaderRow } from './headers.js';
import { parseOfx } from './ofx.js';
import { MAX_IMPORT_BYTES, type ParsedTable, type TableKind } from './types.js';
import { isCompoundFile, parseXls } from './xls.js';
import { parseXlsx } from './xlsx.js';

const KINDS: Record<string, TableKind> = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.ofx': 'ofx',
  '.qfx': 'ofx',
};

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Spreadsheets are read by what they contain, not by their name: banks export legacy workbooks
 * named .xlsx and XLSX archives named .xls. A .xls that is neither (an HTML table or delimited
 * text saved with that extension) is rejected.
 */
async function parseSpreadsheet(buf: Buffer, extension: string): Promise<string[][]> {
  if (isCompoundFile(buf)) return parseXls(buf);
  if (extension === '.xls' && !buf.subarray(0, 4).equals(ZIP_SIGNATURE)) {
    throw new ValidationError('The file is not a valid XLS workbook: save it as .xlsx or CSV');
  }
  return parseXlsx(buf);
}

/**
 * Reads a statement file (CSV, XLSX, XLS or OFX) into a ParsedTable. The file is untrusted: size
 * and row limits are enforced and nothing in it is ever executed. Async because XLSX is.
 *
 * A legacy Excel workbook (.xls) is reported as kind 'xlsx': both are spreadsheet grids whose
 * numbers arrive as plain dot-decimal text, which is what the amount rules and saved formats key on.
 */
export async function parseFile(buf: Buffer, filename: string): Promise<ParsedTable> {
  if (buf.length === 0) throw new ValidationError('The file is empty');
  if (buf.length > MAX_IMPORT_BYTES) {
    throw new ValidationError('The file is too large (maximum 10 MB)');
  }
  const extension = extname(filename).toLowerCase();
  const kind = KINDS[extension];
  if (!kind) throw new ValidationError('Unsupported file type: use CSV, OFX, XLS or XLSX');

  if (kind === 'ofx') {
    return { kind, grid: [], headerRow: 0, headers: [], rows: [], ofx: parseOfx(buf) };
  }
  const grid = kind === 'csv' ? parseCsv(buf) : await parseSpreadsheet(buf, extension);
  const headerRow = detectHeaderRow(grid);
  return {
    kind,
    grid,
    headerRow,
    headers: grid[headerRow] ?? [],
    rows: grid.slice(headerRow + 1),
  };
}
