import { ValidationError } from '../context.js';
import { MAX_IMPORT_ROWS } from './types.js';
import { MAX_XLSX_CELL_CHARS, MAX_XLSX_CELLS, MAX_XLSX_COLUMNS } from './xlsx.js';

/** OLE2 compound file signature: what a legacy Excel workbook (.xls) starts with. */
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** Sector numbers above this are markers (end of chain, free, FAT, DIFAT), not sectors. */
const MAX_REGULAR_SECTOR = 0xfffffffa;
const END_OF_CHAIN = 0xfffffffe;
const HEADER_DIFAT_SLOTS = 109;
const DIR_ENTRY_BYTES = 128;
const MINI_SECTOR_BYTES = 64;
const DIR_TYPE_STREAM = 2;
const DIR_TYPE_ROOT = 5;

const notXls = () => new ValidationError('The file is not a valid XLS workbook');
const protectedWorkbook = () => new ValidationError('The workbook is password-protected');

export function isCompoundFile(buf: Buffer): boolean {
  return buf.length >= CFB_SIGNATURE.length && buf.subarray(0, 8).equals(CFB_SIGNATURE);
}

/**
 * Runs a reader over untrusted bytes: anything it trips on that is not already a ValidationError
 * (a read past the end of a buffer, for instance) means the file is malformed.
 */
function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw notXls();
  }
}

/**
 * The bytes of the `Workbook` stream (`Book` in older writers) of a compound file. Sector chains
 * are followed through the FAT with a hard bound of the number of sectors in the file, so a chain
 * that loops or leaves the file is rejected instead of followed.
 */
export function readWorkbookStream(buf: Buffer): Buffer {
  return guarded(() => {
    if (buf.length < 512 || !isCompoundFile(buf)) throw notXls();
    const shift = buf.readUInt16LE(30);
    if ((shift !== 9 && shift !== 12) || buf.readUInt16LE(32) !== 6) throw notXls();
    const size = 1 << shift;
    const perSector = size / 4;
    // The header fills the first sector-sized block; sector n starts at (n + 1) * size.
    const sectorCount = Math.ceil(buf.length / size) - 1;
    const sector = (n: number): Buffer => {
      if (n >= sectorCount) throw notXls();
      return buf.subarray((n + 1) * size, (n + 2) * size);
    };

    const fatCount = buf.readUInt32LE(44);
    if (fatCount > sectorCount) throw notXls();
    const fatSectors: number[] = [];
    for (let i = 0; i < HEADER_DIFAT_SLOTS && fatSectors.length < fatCount; i += 1) {
      fatSectors.push(buf.readUInt32LE(76 + i * 4));
    }
    let difat = buf.readUInt32LE(68);
    for (let hops = 0; fatSectors.length < fatCount; hops += 1) {
      if (difat > MAX_REGULAR_SECTOR || hops > sectorCount) throw notXls();
      const block = sector(difat);
      for (let i = 0; i < perSector - 1 && fatSectors.length < fatCount; i += 1) {
        fatSectors.push(block.readUInt32LE(i * 4));
      }
      difat = block.readUInt32LE(size - 4);
    }
    const next = (n: number): number => {
      const fatSector = fatSectors[Math.floor(n / perSector)];
      if (fatSector === undefined) throw notXls();
      return sector(fatSector).readUInt32LE((n % perSector) * 4);
    };
    const chain = (start: number): Buffer => {
      const parts: Buffer[] = [];
      for (let n = start; n !== END_OF_CHAIN; n = next(n)) {
        if (n > MAX_REGULAR_SECTOR || parts.length >= sectorCount) throw notXls();
        parts.push(sector(n));
      }
      return Buffer.concat(parts);
    };

    const directory = chain(buf.readUInt32LE(48));
    let root: Buffer | undefined;
    const streams = new Map<string, Buffer>();
    for (let at = 0; at + DIR_ENTRY_BYTES <= directory.length; at += DIR_ENTRY_BYTES) {
      const entry = directory.subarray(at, at + DIR_ENTRY_BYTES);
      const nameBytes = entry.readUInt16LE(64);
      if (nameBytes < 2 || nameBytes > 64) continue;
      const type = entry[66];
      if (type === DIR_TYPE_ROOT) root ??= entry;
      if (type === DIR_TYPE_STREAM) {
        const name = entry.toString('utf16le', 0, nameBytes - 2).toLowerCase();
        if (!streams.has(name)) streams.set(name, entry);
      }
    }
    const entry = streams.get('workbook') ?? streams.get('book');
    // A password-protected OOXML workbook is a compound file too, holding the encrypted archive.
    if (!entry && streams.has('encryptedpackage')) throw protectedWorkbook();
    if (!entry || !root) throw notXls();
    const start = entry.readUInt32LE(116);
    const length = entry.readUInt32LE(120);
    // The high half of the size only counts with 4096-byte sectors; writers of 512-byte-sector
    // files often left it uninitialised.
    if ((shift === 12 && entry.readUInt32LE(124) !== 0) || length > buf.length) throw notXls();

    if (length >= buf.readUInt32LE(56)) {
      const data = chain(start);
      if (data.length < length) throw notXls();
      return data.subarray(0, length);
    }
    // Small streams live in the mini stream: 64-byte sectors inside the root entry's own chain.
    const container = chain(root.readUInt32LE(116));
    const miniFat = chain(buf.readUInt32LE(60));
    const miniCount = Math.floor(container.length / MINI_SECTOR_BYTES);
    const parts: Buffer[] = [];
    for (let n = start; n !== END_OF_CHAIN; n = miniFat.readUInt32LE(n * 4)) {
      if (n >= miniCount || parts.length >= miniCount) throw notXls();
      parts.push(container.subarray(n * MINI_SECTOR_BYTES, (n + 1) * MINI_SECTOR_BYTES));
    }
    const data = Buffer.concat(parts);
    if (data.length < length) throw notXls();
    return data.subarray(0, length);
  });
}

const BIFF8 = 0x0600;
const R = {
  FORMULA: 0x06,
  EOF: 0x0a,
  DATEMODE: 0x22,
  FILEPASS: 0x2f,
  CONTINUE: 0x3c,
  BOUNDSHEET: 0x85,
  MULRK: 0xbd,
  XF: 0xe0,
  SST: 0xfc,
  LABELSST: 0xfd,
  NUMBER: 0x203,
  LABEL: 0x204,
  BOOLERR: 0x205,
  STRING: 0x207,
  RK: 0x27e,
  FORMAT: 0x41e,
  BOF: 0x809,
} as const;
/** BOF record types of BIFF2, BIFF3 and BIFF4 (BIFF5 shares 0x809 and differs by version). */
const OLD_BOF = new Set([0x09, 0x209, 0x409]);
const MS_PER_DAY = 86_400_000;
/** Largest date serial Excel knows (9999-12-31). */
const MAX_DATE_SERIAL = 2_958_465;

const tooOld = () => new ValidationError('Excel 95 and older workbooks are not supported');
const tooMuchText = () =>
  new ValidationError(`A cell holds too much text (maximum ${MAX_XLSX_CELL_CHARS} characters)`);

interface BiffRecord {
  type: number;
  data: Buffer;
  /** Offset of the record after this one. */
  next: number;
}

function recordAt(wb: Buffer, pos: number): BiffRecord {
  if (pos + 4 > wb.length) throw notXls();
  const next = pos + 4 + wb.readUInt16LE(pos + 2);
  if (next > wb.length) throw notXls();
  return { type: wb.readUInt16LE(pos), data: wb.subarray(pos + 4, next), next };
}

/**
 * Reads values that may run from a record into the CONTINUE records after it. A string's
 * characters may be cut at a record boundary; the next record then starts with a new flags byte
 * saying whether the rest is stored as 8-bit or 16-bit characters.
 */
class RecordReader {
  private segment = 0;
  private pos = 0;

  constructor(private readonly segments: Buffer[]) {}

  /** A record's data followed by the data of every CONTINUE record directly after it. */
  static at(wb: Buffer, first: BiffRecord): { reader: RecordReader; next: number } {
    const segments = [first.data];
    let next = first.next;
    while (next + 4 <= wb.length && wb.readUInt16LE(next) === R.CONTINUE) {
      const more = recordAt(wb, next);
      segments.push(more.data);
      next = more.next;
    }
    return { reader: new RecordReader(segments), next };
  }

  private current(): Buffer {
    const segment = this.segments[this.segment];
    if (!segment) throw notXls();
    return segment;
  }

  /** Moves to the next record when this one is used up; true when it did. */
  private advance(): boolean {
    if (this.pos < this.current().length) return false;
    this.segment += 1;
    this.pos = 0;
    return true;
  }

  private take(bytes: number): Buffer {
    this.advance();
    const segment = this.current();
    if (this.pos + bytes > segment.length) throw notXls();
    this.pos += bytes;
    return segment.subarray(this.pos - bytes, this.pos);
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  skip(bytes: number): void {
    for (let left = bytes; left > 0;) {
      this.advance();
      const step = Math.min(left, this.current().length - this.pos);
      if (step <= 0) throw notXls();
      this.pos += step;
      left -= step;
    }
  }

  /** A string with a 16-bit character count: flags, optional rich-text and phonetic blocks. */
  string(): string {
    const count = this.u16();
    if (count > MAX_XLSX_CELL_CHARS) throw tooMuchText();
    const flags = this.u8();
    let wide = (flags & 0x01) !== 0;
    const runs = flags & 0x08 ? this.u16() : 0;
    const phonetic = flags & 0x04 ? this.u32() : 0;
    let text = '';
    for (let left = count; left > 0;) {
      if (this.advance()) wide = (this.u8() & 0x01) !== 0;
      const width = wide ? 2 : 1;
      const fit = Math.min(left, Math.floor((this.current().length - this.pos) / width));
      if (fit <= 0) throw notXls();
      text += this.take(fit * width).toString(wide ? 'utf16le' : 'latin1');
      left -= fit;
    }
    this.skip(runs * 4 + phonetic);
    return text;
  }
}

/**
 * Whether a custom number format shows a calendar date. Literal text (quoted, escaped, padding and
 * fill characters) and bracketed sections such as colours and locale tags are not format codes.
 * Time-only formats are left as numbers.
 */
function isDateFormatText(format: string): boolean {
  const codes = format.replace(/"[^"]*"|\\.|[_*].|\[[^\]]*\]/g, '');
  return /[dy]/i.test(codes);
}

/** Built-in number formats that show a date: 14-17 and 22, plus the East Asian date formats. */
function isBuiltInDateFormat(id: number): boolean {
  return (
    (id >= 14 && id <= 17) ||
    id === 22 ||
    (id >= 27 && id <= 31) ||
    id === 36 ||
    (id >= 50 && id <= 58)
  );
}

function rkValue(rk: number): number {
  let value: number;
  if (rk & 0x02) {
    value = rk >> 2;
  } else {
    const bits = Buffer.alloc(8);
    bits.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = bits.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

interface Globals {
  date1904: boolean;
  /** Per XF index: whether its number format shows a date. */
  dateXf: boolean[];
  strings: string[];
  sheets: Array<{ offset: number; hidden: boolean; worksheet: boolean }>;
}

function readGlobals(wb: Buffer): Globals {
  const bof = recordAt(wb, 0);
  if (OLD_BOF.has(bof.type)) throw tooOld();
  if (bof.type !== R.BOF) throw notXls();
  if (bof.data.readUInt16LE(0) !== BIFF8) throw tooOld();

  const globals: Globals = { date1904: false, dateXf: [], strings: [], sheets: [] };
  const customDate = new Map<number, boolean>();
  const xfFormats: number[] = [];
  for (let pos = bof.next; pos < wb.length;) {
    const record = recordAt(wb, pos);
    pos = record.next;
    const { type, data } = record;
    if (type === R.EOF) break;
    if (type === R.FILEPASS) throw protectedWorkbook();
    if (type === R.DATEMODE) globals.date1904 = data.readUInt16LE(0) === 1;
    if (type === R.XF) xfFormats.push(data.readUInt16LE(2));
    if (type === R.FORMAT) {
      const reader = new RecordReader([data]);
      const id = reader.u16();
      customDate.set(id, isDateFormatText(reader.string()));
    }
    if (type === R.BOUNDSHEET) {
      globals.sheets.push({
        offset: data.readUInt32LE(0),
        hidden: (data.readUInt8(4) & 0x03) !== 0,
        worksheet: data.readUInt8(5) === 0,
      });
    }
    if (type === R.SST) {
      const { reader, next } = RecordReader.at(wb, record);
      reader.skip(4);
      const unique = reader.u32();
      // Every string takes at least three bytes: a bigger count than that cannot be honest.
      if (unique > wb.length / 3) throw notXls();
      for (let i = 0; i < unique; i += 1) globals.strings.push(reader.string());
      pos = next;
    }
  }
  globals.dateXf = xfFormats.map((id) => customDate.get(id) ?? isBuiltInDateFormat(id));
  return globals;
}

/**
 * Reads the first visible worksheet of a legacy Excel workbook (.xls, BIFF8: Excel 97 to 2003)
 * into rows of strings, in the shape parseXlsx returns: numbers as plain text with a dot, numbers
 * formatted as dates as YYYY-MM-DD, rows as long as their last real cell with gaps filled by ''.
 * Formulas are never evaluated: only the result stored in the file is read. The file is untrusted:
 * every read is bounds-checked and the limits of the XLSX reader apply (rows, columns, cells and
 * text per cell).
 */
export function parseXls(buf: Buffer): string[][] {
  const wb = readWorkbookStream(buf);
  return guarded(() => {
    const globals = readGlobals(wb);
    const sheet = globals.sheets.find((s) => s.worksheet && !s.hidden);
    if (!sheet) throw new ValidationError('The workbook has no visible worksheet');
    const first = recordAt(wb, sheet.offset);
    if (first.type !== R.BOF) throw notXls();

    const grid: string[][] = [];
    let cells = 0;
    const put = (row: number, col: number, text: string): void => {
      if (row >= MAX_IMPORT_ROWS) {
        throw new ValidationError(`The file has too many rows (maximum ${MAX_IMPORT_ROWS} rows)`);
      }
      if (col >= MAX_XLSX_COLUMNS) {
        throw new ValidationError(
          `The spreadsheet has too many columns (maximum ${MAX_XLSX_COLUMNS})`,
        );
      }
      if (++cells > MAX_XLSX_CELLS) throw new ValidationError('The spreadsheet has too many cells');
      if (text.length > MAX_XLSX_CELL_CHARS) throw tooMuchText();
      if (text === '') return;
      while (grid.length <= row) grid.push([]);
      const cellsOfRow = grid[row]!;
      while (cellsOfRow.length < col) cellsOfRow.push('');
      cellsOfRow[col] = text;
    };
    const numberText = (value: number, xf: number): string => {
      if (!Number.isFinite(value)) return '';
      if (globals.dateXf[xf] && value >= 0 && value <= MAX_DATE_SERIAL) {
        const epoch = globals.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
        return new Date(epoch + Math.floor(value) * MS_PER_DAY).toISOString().slice(0, 10);
      }
      return String(Number(value.toPrecision(15)));
    };

    // A formula whose result is text keeps it in a STRING record that follows.
    let pendingText: { row: number; col: number } | undefined;
    // Embedded objects (charts) are nested substreams with their own BOF and EOF.
    let depth = 1;
    for (let pos = first.next; pos < wb.length && depth > 0;) {
      const record = recordAt(wb, pos);
      pos = record.next;
      const { type, data } = record;
      if (type === R.BOF) depth += 1;
      if (type === R.EOF) depth -= 1;
      if (depth !== 1) continue;
      if (type === R.LABELSST) {
        const text = globals.strings[data.readUInt32LE(6)];
        if (text === undefined) throw notXls();
        put(data.readUInt16LE(0), data.readUInt16LE(2), text);
      } else if (type === R.NUMBER) {
        const xf = data.readUInt16LE(4);
        put(data.readUInt16LE(0), data.readUInt16LE(2), numberText(data.readDoubleLE(6), xf));
      } else if (type === R.RK) {
        const value = rkValue(data.readUInt32LE(6));
        put(data.readUInt16LE(0), data.readUInt16LE(2), numberText(value, data.readUInt16LE(4)));
      } else if (type === R.MULRK) {
        const row = data.readUInt16LE(0);
        const firstCol = data.readUInt16LE(2);
        for (let at = 4, col = firstCol; at + 6 <= data.length - 2; at += 6, col += 1) {
          put(row, col, numberText(rkValue(data.readUInt32LE(at + 2)), data.readUInt16LE(at)));
        }
      } else if (type === R.FORMULA) {
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        if (data.readUInt16LE(12) !== 0xffff) {
          put(row, col, numberText(data.readDoubleLE(6), data.readUInt16LE(4)));
        } else if (data.readUInt8(6) === 0) {
          pendingText = { row, col };
        } else if (data.readUInt8(6) === 1) {
          put(row, col, data.readUInt8(8) ? 'TRUE' : 'FALSE');
        }
      } else if (type === R.STRING) {
        const { reader, next } = RecordReader.at(wb, record);
        if (pendingText) put(pendingText.row, pendingText.col, reader.string());
        pendingText = undefined;
        pos = next;
      } else if (type === R.LABEL) {
        const text = new RecordReader([data.subarray(6)]).string();
        put(data.readUInt16LE(0), data.readUInt16LE(2), text);
      } else if (type === R.BOOLERR && data.readUInt8(7) === 0) {
        put(data.readUInt16LE(0), data.readUInt16LE(2), data.readUInt8(6) ? 'TRUE' : 'FALSE');
      }
    }
    if (grid.length === 0) throw new ValidationError('The spreadsheet is empty');
    return grid;
  });
}
