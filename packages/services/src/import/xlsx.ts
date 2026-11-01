import { PassThrough } from 'node:stream';
import { posix } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { SaxesParser } from 'saxes';
import { ValidationError } from '../context.js';
import { MAX_IMPORT_ROWS } from './types.js';

/** Total unpacked size ceiling for the archive, and for each worksheet XML entry. */
export const MAX_XLSX_UNPACKED_BYTES = 30 * 1024 * 1024;
export const MAX_XLSX_SHEET_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_SHARED_STRINGS_BYTES = 10 * 1024 * 1024;
/** xl/workbook.xml and its relationships part, which we parse ourselves. */
export const MAX_XLSX_WORKBOOK_PART_BYTES = 1024 * 1024;
/** Longest text a single cell may hold. */
export const MAX_XLSX_CELL_CHARS = 10_000;
const MAX_XLSX_ENTRIES = 1_000;
export const MAX_XLSX_COLUMNS = 200;
/** Real (non-empty) cells in the sheet. */
export const MAX_XLSX_CELLS = 2_000_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
const WORKSHEET_ENTRY = /^xl\/worksheets\/[^/]+\.xml$/;
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const WORKBOOK_PARTS = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
const KEEP_ENTRIES = new Set([
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  SHARED_STRINGS,
  '[Content_Types].xml',
  '_rels/.rels',
]);

const tooLarge = () =>
  new ValidationError('The spreadsheet is too large when unpacked (possible zip bomb)');
const notXlsx = () => new ValidationError('The file is not a valid XLSX workbook');

const mismatch = () => new ValidationError('The spreadsheet is corrupt (entry size mismatch)');

interface CentralRecord {
  name: string;
  flags: number;
  method: number;
  packed: number;
  declared: number;
  localOffset: number;
}

/** Entries kept after verification: the workbook parts and every worksheet. */
function isWanted(name: string): boolean {
  return KEEP_ENTRIES.has(name) || WORKSHEET_ENTRY.test(name);
}

/**
 * Archive guard, run before anything is parsed. Returns the inflated bytes of the entries a
 * workbook needs (the workbook parts and every worksheet); everything else is verified and dropped.
 *  - The central directory is walked by its byte range and must be well formed: the record count
 *    must equal the end-of-directory entry count, the directory must end exactly where the
 *    end-of-directory record starts, and the end record must be the only one (no comment or
 *    trailing-data tricks). Encrypted entries, ZIP64, duplicate names and unknown methods are rejected.
 *  - Local entries must tile the file exactly (first at offset 0, each starting where the previous
 *    one, with its data descriptor if any, ends, the last ending at the directory), so no local
 *    entry can hide outside the central directory. Each local header must agree with its central
 *    record (name, method and, unless a data descriptor follows, sizes).
 *  - Declared unpacked sizes are capped (30 MiB total, 25 MiB per worksheet, 10 MiB shared strings),
 *    at most 1,000 entries, and each entry is inflated here with an output cap of its declared size
 *    that must be matched exactly (sizes are never taken from a data descriptor).
 * exceljs never sees the upload: parseXlsx rebuilds a canonical archive from what this returns.
 */
export function assertSafeXlsxArchive(buf: Buffer): Map<string, Buffer> {
  const start = Math.max(0, buf.length - EOCD_SEARCH);
  let eocd = -1;
  for (let i = buf.length - EOCD_MIN; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notXlsx();
  // The comment must run exactly to the end of the file and must not hide another end record.
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + EOCD_MIN + commentLen !== buf.length) throw notXlsx();
  if (buf.subarray(eocd + 4, buf.length).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) {
    throw notXlsx();
  }
  const entries = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers: Excel never writes them for ordinary workbooks.
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw tooLarge();
  if (entries === 0 || entries > MAX_XLSX_ENTRIES) throw tooLarge();
  const dirEnd = dirOffset + dirSize;
  if (dirEnd !== eocd || dirOffset > eocd) throw notXlsx();

  const records: CentralRecord[] = [];
  let total = 0;
  let pos = dirOffset;
  while (pos < dirEnd) {
    if (records.length + 1 > entries) throw notXlsx();
    if (pos + 46 > dirEnd || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw notXlsx();
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const entryCommentLen = buf.readUInt16LE(pos + 32);
    const next = pos + 46 + nameLen + extraLen + entryCommentLen;
    if (next > dirEnd) throw notXlsx();
    const record: CentralRecord = {
      name: buf.toString('latin1', pos + 46, pos + 46 + nameLen),
      flags: buf.readUInt16LE(pos + 8),
      method: buf.readUInt16LE(pos + 10),
      packed: buf.readUInt32LE(pos + 20),
      declared: buf.readUInt32LE(pos + 24),
      localOffset: buf.readUInt32LE(pos + 42),
    };
    // Encrypted (bit 0) or strongly encrypted (bit 6) entries cannot be read.
    if (record.flags & 0x41) throw notXlsx();
    if (record.packed === 0xffffffff || record.declared === 0xffffffff) throw tooLarge();
    total += record.declared;
    if (total > MAX_XLSX_UNPACKED_BYTES) throw tooLarge();
    if (WORKSHEET_ENTRY.test(record.name) && record.declared > MAX_XLSX_SHEET_BYTES) {
      throw tooLarge();
    }
    if (WORKBOOK_PARTS.has(record.name) && record.declared > MAX_XLSX_WORKBOOK_PART_BYTES) {
      throw tooLarge();
    }
    if (record.name === SHARED_STRINGS && record.declared > MAX_XLSX_SHARED_STRINGS_BYTES) {
      throw tooLarge();
    }
    records.push(record);
    pos = next;
  }
  if (records.length !== entries || pos !== dirEnd) throw notXlsx();
  if (new Set(records.map((r) => r.name)).size !== records.length) throw notXlsx();

  // Local entries must tile [0, dirOffset) with no gaps: nothing hides outside the directory.
  const kept = new Map<string, Buffer>();
  let expected = 0;
  for (const record of [...records].sort((x, y) => x.localOffset - y.localOffset)) {
    if (record.localOffset !== expected) throw notXlsx();
    const { dataStart, end } = checkLocalHeader(buf, record, dirOffset);
    const data = inflateEntry(buf.subarray(dataStart, dataStart + record.packed), record);
    if (isWanted(record.name)) kept.set(record.name, data);
    expected = end;
  }
  if (expected !== dirOffset) throw notXlsx();
  return kept;
}

/** Checks a local header against its central record; returns where its data starts and the entry ends. */
function checkLocalHeader(
  buf: Buffer,
  r: CentralRecord,
  limit: number,
): { dataStart: number; end: number } {
  const o = r.localOffset;
  if (o + 30 > limit || buf.readUInt32LE(o) !== LOCAL_SIGNATURE) throw notXlsx();
  const flags = buf.readUInt16LE(o + 6);
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  if (flags & 0x41) throw notXlsx();
  if (buf.readUInt16LE(o + 8) !== r.method) throw mismatch();
  if (buf.toString('latin1', o + 30, o + 30 + nameLen) !== r.name) throw mismatch();
  const descriptor = (flags & 0x08) !== 0;
  const localPacked = buf.readUInt32LE(o + 18);
  const localDeclared = buf.readUInt32LE(o + 22);
  if (descriptor) {
    // Sizes come from the central record only; the local ones must be unset or agree.
    const unsetOrEqual = (local: number, central: number) => local === 0 || local === central;
    if (!unsetOrEqual(localPacked, r.packed) || !unsetOrEqual(localDeclared, r.declared)) {
      throw mismatch();
    }
  } else if (localPacked !== r.packed || localDeclared !== r.declared) {
    throw mismatch();
  }
  let end = dataStart + r.packed;
  if (end > limit) throw notXlsx();
  if (descriptor) {
    end += end + 4 <= limit && buf.readUInt32LE(end) === 0x08074b50 ? 16 : 12;
    if (end > limit) throw notXlsx();
  }
  return { dataStart, end };
}

function inflateEntry(data: Buffer, r: CentralRecord): Buffer {
  if (r.method === 0) {
    if (r.packed !== r.declared) throw mismatch();
    return data;
  }
  if (r.method !== 8) throw notXlsx();
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(data, { maxOutputLength: Math.max(r.declared, 1) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw mismatch();
    throw notXlsx();
  }
  if (inflated.length !== r.declared) throw mismatch();
  return inflated;
}

/** A STORED (method 0) zip of `entries`, in the given order. Sizes and CRCs are known up front. */
function storedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'latin1');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(EOCD_MIN);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Transitional (Office default) and Strict OOXML relationships namespaces. */
const REL_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];

type XmlAttr = { local: string; uri: string; value: string };

/**
 * Calls `visit` for every element start with its attributes. Linear-time SAX parsing (saxes,
 * namespace-aware): untrusted XML is never scanned with regular expressions. Malformed XML is
 * rejected.
 */
function visitElements(xml: string, visit: (local: string, attrs: XmlAttr[]) => void): void {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('opentag', (node) => {
    visit(node.local, Object.values(node.attributes) as XmlAttr[]);
  });
  try {
    parser.write(xml).close();
  } catch {
    throw notXlsx();
  }
}

const attr = (attrs: XmlAttr[], local: string, uri = ''): string | undefined =>
  attrs.find((a) => a.local === local && a.uri === uri)?.value;

type SheetRef = { name: string; part: string; hidden: boolean };

/**
 * The worksheets listed in xl/workbook.xml, in order, each resolved through its relationship id
 * (any namespace prefix, transitional or Strict relationships namespace) to a part of the archive.
 * Sheets whose relationship does not resolve to a kept worksheet part are left out.
 */
function listSheets(kept: Map<string, Buffer>): SheetRef[] {
  const targets = new Map<string, string>();
  visitElements(kept.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '', (local, attrs) => {
    if (local !== 'Relationship') return;
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    if (id !== undefined && target !== undefined) targets.set(id, target);
  });
  const sheets: SheetRef[] = [];
  visitElements(kept.get('xl/workbook.xml')?.toString('utf8') ?? '', (local, attrs) => {
    if (local !== 'sheet') return;
    const state = attr(attrs, 'state');
    const rid = REL_NAMESPACES.map((ns) => attr(attrs, 'id', ns)).find((v) => v !== undefined);
    const target = rid === undefined ? undefined : targets.get(rid);
    if (target === undefined) return;
    const part = posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    if (kept.has(part) && WORKSHEET_ENTRY.test(part)) {
      sheets.push({
        name: attr(attrs, 'name') ?? '',
        part,
        hidden: state === 'hidden' || state === 'veryHidden',
      });
    }
  });
  return sheets;
}

/** The worksheet part to read by default: the first sheet listed in the workbook that is not hidden. */
function selectWorksheet(kept: Map<string, Buffer>): string {
  const selected = listSheets(kept).find((sheet) => !sheet.hidden);
  if (selected === undefined) throw new ValidationError('The workbook has no visible worksheet');
  return selected.part;
}

const EMPTY_SST = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';

/**
 * Builds the only archive exceljs ever reads: the verified workbook parts and one
 * worksheet, stored uncompressed, in the order the streaming reader needs (workbook, rels, styles
 * and shared strings before the sheet) so that it never spools anything to a temp file.
 */
function canonicalArchive(kept: Map<string, Buffer>, sheet: string): Buffer {
  const need = (name: string): Buffer => {
    const data = kept.get(name);
    if (!data) throw notXlsx();
    return data;
  };
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'xl/workbook.xml', data: need('xl/workbook.xml') },
    { name: 'xl/_rels/workbook.xml.rels', data: need('xl/_rels/workbook.xml.rels') },
  ];
  const styles = kept.get('xl/styles.xml');
  if (styles) entries.push({ name: 'xl/styles.xml', data: styles });
  entries.push(
    { name: SHARED_STRINGS, data: kept.get(SHARED_STRINGS) ?? Buffer.from(EMPTY_SST) },
    { name: '[Content_Types].xml', data: need('[Content_Types].xml') },
    { name: '_rels/.rels', data: need('_rels/.rels') },
    { name: 'xl/worksheets/sheet1.xml', data: need(sheet) },
  );
  return storedZip(entries);
}

/** Cell text only: formulas are never evaluated, only the result stored in the file is read. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Number(value.toPrecision(15))) : '';
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('error' in value) return '';
  if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
  if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
  return '';
}

/** A cell value that keeps numbers (and the stored result of a formula) as numbers; text otherwise. */
export type TypedCell = string | number;

function typedCell(value: ExcelJS.CellValue): TypedCell {
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    if ('result' in value && typeof value.result === 'number') return typedCell(value.result);
  }
  return cellText(value);
}

/**
 * Reads the (single) worksheet of a canonical archive into rows of strings (dates as YYYY-MM-DD,
 * numbers as plain text), or with `typed` into rows where numbers stay numbers. Uses exceljs' streaming reader and keeps only real cells, aborting as
 * soon as a limit is hit: more than MAX_IMPORT_ROWS rows, more than MAX_XLSX_CELLS cells or a cell
 * beyond column MAX_XLSX_COLUMNS. Rows are as long as their last real cell (gaps filled with ''),
 * so the result is never bigger than the data.
 */
async function readSheet(archive: Buffer, typed: true): Promise<TypedCell[][]>;
async function readSheet(archive: Buffer, typed: false): Promise<string[][]>;
async function readSheet(archive: Buffer, typed: boolean): Promise<TypedCell[][]> {
  const input = new PassThrough();
  input.end(archive);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  });
  const grid: TypedCell[][] = [];
  let cells = 0;
  try {
    for await (const sheet of reader) {
      for await (const row of sheet) {
        if (row.number > MAX_IMPORT_ROWS) {
          throw new ValidationError(`The file has too many rows (maximum ${MAX_IMPORT_ROWS} rows)`);
        }
        const values: TypedCell[] = [];
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          if (col > MAX_XLSX_COLUMNS) {
            throw new ValidationError(
              `The spreadsheet has too many columns (maximum ${MAX_XLSX_COLUMNS})`,
            );
          }
          if (++cells > MAX_XLSX_CELLS) {
            throw new ValidationError('The spreadsheet has too many cells');
          }
          while (values.length < col - 1) values.push('');
          const value = typed ? typedCell(cell.value) : cellText(cell.value);
          const text = typeof value === 'string' ? value : '';
          if (text.length > MAX_XLSX_CELL_CHARS) {
            throw new ValidationError(
              `A cell holds too much text (maximum ${MAX_XLSX_CELL_CHARS} characters)`,
            );
          }
          values[col - 1] = value;
        });
        while (grid.length < row.number - 1) grid.push([]);
        grid[row.number - 1] = values;
      }
      break; // the canonical archive holds one worksheet
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw notXlsx();
  } finally {
    input.destroy();
  }
  return grid;
}

/**
 * Reads the first visible worksheet into rows of strings (see readSheet), from a canonical
 * rebuilt archive.
 */
export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const kept = assertSafeXlsxArchive(buf);
  const grid = await readSheet(canonicalArchive(kept, selectWorksheet(kept)), false);
  if (grid.length === 0) throw new ValidationError('The spreadsheet is empty');
  return grid;
}

/**
 * Reads the visible worksheets called `names` (matched with `sameName`; the first match wins) into
 * rows of cells (numbers stay numbers, everything else is text), each through its own canonical
 * archive with every limit of readSheet. A sheet that is absent is absent from the result; an empty one is `[]`. The archive guard runs once.
 */
export async function parseXlsxSheets(
  buf: Buffer,
  names: readonly string[],
  sameName: (sheetName: string, wanted: string) => boolean,
): Promise<Map<string, TypedCell[][]>> {
  const kept = assertSafeXlsxArchive(buf);
  const visible = listSheets(kept).filter((sheet) => !sheet.hidden);
  if (visible.length === 0) {
    throw new ValidationError('The workbook has no visible worksheet', [], 'no_visible_sheet');
  }
  const result = new Map<string, TypedCell[][]>();
  for (const wanted of names) {
    const sheet = visible.find((s) => sameName(s.name, wanted));
    if (sheet) result.set(wanted, await readSheet(canonicalArchive(kept, sheet.part), true));
  }
  return result;
}
