/**
 * Test-only writer of minimal legacy Excel files: an OLE2 compound file holding one stream.
 * It writes just enough for the reader under test; it is not a general-purpose writer.
 */

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const FREE = 0xffffffff;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function pad(data: Buffer, unit: number): Buffer {
  const rest = data.length % unit;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(unit - rest)]);
}

function u32Table(values: number[], unit: number): Buffer {
  const out = Buffer.alloc(Math.ceil((values.length * 4) / unit) * unit, 0xff);
  values.forEach((value, i) => out.writeUInt32LE(value >>> 0, i * 4));
  return out;
}

function dirEntry(
  name: string,
  type: number,
  child: number,
  start: number,
  size: number,
  sizeHigh = 0,
): Buffer {
  const entry = Buffer.alloc(128);
  entry.write(name, 0, 'utf16le');
  entry.writeUInt16LE((name.length + 1) * 2, 64);
  entry[66] = type;
  entry[67] = 1;
  entry.writeUInt32LE(FREE, 68);
  entry.writeUInt32LE(FREE, 72);
  entry.writeUInt32LE(child >>> 0, 76);
  entry.writeUInt32LE(start >>> 0, 116);
  entry.writeUInt32LE(size, 120);
  entry.writeUInt32LE(sizeHigh >>> 0, 124);
  return entry;
}

export interface CfbOptions {
  /** Stream name; Excel writes `Workbook`. */
  name?: string;
  /** Store the stream in the mini stream (default: whenever it is under 4096 bytes). */
  mini?: boolean;
  /** High 32 bits of the stream size, which old writers of 512-byte-sector files left as garbage. */
  sizeHigh?: number;
  /** Last-minute edit of the FAT (sector index -> next sector), to build corrupt files. */
  fatPatch?: (fat: number[]) => void;
}

/** A compound file with a root entry and one stream. */
export function buildCfb(stream: Buffer, opts: CfbOptions = {}): Buffer {
  const mini = opts.mini ?? stream.length < MINI_CUTOFF;
  if (mini && stream.length >= MINI_CUTOFF) throw new Error('mini streams are under 4096 bytes');

  // Sector layout: [data sectors][mini FAT sector, mini only][directory sector][FAT sectors].
  const data = pad(mini ? pad(stream, MINI_SECTOR) : stream, SECTOR);
  const dataSectors = data.length / SECTOR;
  const miniFatSectors = mini ? 1 : 0;
  const dirSector = dataSectors + miniFatSectors;
  let fatSectors = 1;
  while (dirSector + 1 + fatSectors > fatSectors * (SECTOR / 4)) fatSectors += 1;

  const fat: number[] = [];
  for (let i = 0; i < dataSectors; i += 1) fat.push(i === dataSectors - 1 ? END_OF_CHAIN : i + 1);
  if (mini) fat.push(END_OF_CHAIN);
  fat.push(END_OF_CHAIN);
  for (let i = 0; i < fatSectors; i += 1) fat.push(FAT_SECTOR);
  opts.fatPatch?.(fat);

  const miniSectors = Math.ceil(stream.length / MINI_SECTOR);
  const miniFat: number[] = [];
  for (let i = 0; i < miniSectors; i += 1)
    miniFat.push(i === miniSectors - 1 ? END_OF_CHAIN : i + 1);

  const header = Buffer.alloc(SECTOR);
  Buffer.from(SIGNATURE).copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirSector, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(mini ? dataSectors : END_OF_CHAIN, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(END_OF_CHAIN, 68);
  header.fill(0xff, 76);
  for (let i = 0; i < fatSectors; i += 1) header.writeUInt32LE(dirSector + 1 + i, 76 + i * 4);

  const directory = pad(
    Buffer.concat([
      mini
        ? dirEntry('Root Entry', 5, 1, 0, miniSectors * MINI_SECTOR)
        : dirEntry('Root Entry', 5, 1, END_OF_CHAIN, 0),
      dirEntry(opts.name ?? 'Workbook', 2, FREE, 0, stream.length, opts.sizeHigh),
    ]),
    SECTOR,
  );

  return Buffer.concat([
    header,
    data,
    ...(mini ? [u32Table(miniFat, SECTOR)] : []),
    directory,
    u32Table(fat, SECTOR),
  ]);
}

/** One BIFF record: type, length, data. */
export function rec(type: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

export type XlsCell =
  | string
  | number
  | null
  /** A number stored with a date format: built-in format 14, or the custom `format` text. */
  | { date: number; format?: string }
  /** A raw 32-bit RK value. */
  | { rk: number }
  /** A formula cell holding this cached result. */
  | { formula: number | string }
  | { bool: boolean }
  /** An inline LABEL record instead of a shared string. */
  | { label: string }
  /** A LABELSST record pointing at this raw shared-string index. */
  | { sst: number };

export interface XlsSheet {
  name?: string;
  hidden?: boolean;
  rows: Array<Array<XlsCell>>;
  /** Row index of the first entry of `rows` (default 0). */
  firstRow?: number;
  /** Column index of the first cell of every row (default 0). */
  firstCol?: number;
  /** Write runs of adjacent RK cells as one MULRK record. */
  mulrk?: boolean;
}

export interface XlsOptions {
  date1904?: boolean;
  /** BOF version; 0x0600 is BIFF8 (Excel 97-2003). */
  biffVersion?: number;
  /** Mark the workbook as encrypted. */
  filepass?: boolean;
  /** Split every shared string after this many characters into a CONTINUE record. */
  sstChunk?: number;
}

const MAX_RECORD = 8224;
const wide = (text: string) => [...text].some((ch) => ch.charCodeAt(0) > 0xff);
const chars = (text: string, isWide: boolean) => Buffer.from(text, isWide ? 'utf16le' : 'latin1');
const u16 = (...values: number[]) => {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeUInt16LE(value, i * 2));
  return out;
};
const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
};
const f64 = (value: number) => {
  const out = Buffer.alloc(8);
  out.writeDoubleLE(value, 0);
  return out;
};
/** A string with a 16-bit character count and a flags byte. */
const str16 = (text: string) =>
  Buffer.concat([u16(text.length), Buffer.from([wide(text) ? 1 : 0]), chars(text, wide(text))]);

function bof(version: number, type: number): Buffer {
  return rec(0x809, Buffer.concat([u16(version, type, 0x0dbb, 0x07cc), u32(0), u32(6)]));
}

/** The SST record and its CONTINUE records, splitting strings where a record fills up. */
function sharedStrings(strings: string[], chunk: number | undefined): Buffer {
  const records: Buffer[][] = [[u32(strings.length), u32(strings.length)]];
  const size = () => records.at(-1)!.reduce((sum, part) => sum + part.length, 0);
  for (const text of strings) {
    if (size() + 5 > MAX_RECORD) records.push([]);
    let rest = text;
    let first = true;
    do {
      if (!first) records.push([]);
      const space = MAX_RECORD - size() - (first ? 3 : 1);
      let take = Math.min(chunk ?? rest.length, rest.length);
      const isWide = wide(rest.slice(0, take));
      take = Math.min(take, Math.floor(space / (isWide ? 2 : 1)));
      if (first) records.at(-1)!.push(u16(text.length));
      records.at(-1)!.push(Buffer.from([isWide ? 1 : 0]), chars(rest.slice(0, take), isWide));
      rest = rest.slice(take);
      first = false;
    } while (rest.length > 0);
  }
  return Buffer.concat(records.map((parts, i) => rec(i === 0 ? 0xfc : 0x3c, Buffer.concat(parts))));
}

/** The `Workbook` stream: a globals substream followed by one substream per sheet. */
export function buildWorkbookStream(sheets: XlsSheet[], opts: XlsOptions = {}): Buffer {
  const strings: string[] = [];
  const stringIndex = (text: string) => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : strings.push(text) - 1;
  };
  // XF 0 is General; one more XF per distinct date format.
  const xfFormats: number[] = [0];
  const customFormats: string[] = [];
  const xfFor = (format: string | undefined) => {
    let id = 14;
    if (format !== undefined) {
      if (!customFormats.includes(format)) customFormats.push(format);
      id = 164 + customFormats.indexOf(format);
    }
    const at = xfFormats.indexOf(id);
    return at >= 0 ? at : xfFormats.push(id) - 1;
  };

  const sheetStreams = sheets.map((sheet) => {
    const out: Buffer[] = [bof(0x0600, 0x0010)];
    sheet.rows.forEach((row, r) => {
      const rowIndex = (sheet.firstRow ?? 0) + r;
      for (let c = 0; c < row.length; c += 1) {
        const cell = row[c];
        const col = (sheet.firstCol ?? 0) + c;
        const at = (xf = 0) => u16(rowIndex, col, xf);
        if (cell === null || cell === undefined) continue;
        if (typeof cell === 'string') {
          out.push(rec(0xfd, Buffer.concat([at(), u32(stringIndex(cell))])));
        } else if (typeof cell === 'number') {
          out.push(rec(0x203, Buffer.concat([at(), f64(cell)])));
        } else if ('date' in cell) {
          out.push(rec(0x203, Buffer.concat([at(xfFor(cell.format)), f64(cell.date)])));
        } else if ('rk' in cell) {
          const run = [cell.rk];
          while (sheet.mulrk) {
            const next = row[c + run.length];
            if (next === null || typeof next !== 'object' || !('rk' in next)) break;
            run.push(next.rk);
          }
          if (run.length > 1) {
            const body = run.map((rk) => Buffer.concat([u16(0), u32(rk)]));
            out.push(
              rec(0xbd, Buffer.concat([u16(rowIndex, col), ...body, u16(col + run.length - 1)])),
            );
            c += run.length - 1;
          } else {
            out.push(rec(0x27e, Buffer.concat([at(), u32(cell.rk)])));
          }
        } else if ('formula' in cell) {
          const text = typeof cell.formula === 'string' ? cell.formula : undefined;
          const result =
            text === undefined
              ? f64(cell.formula as number)
              : Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
          // Tokens: a single ptgInt, never read by the importer.
          const tokens = Buffer.from([0x1e, 0x01, 0x00]);
          out.push(
            rec(0x06, Buffer.concat([at(), result, u16(0), u32(0), u16(tokens.length), tokens])),
          );
          if (text !== undefined) out.push(rec(0x207, str16(text)));
        } else if ('bool' in cell) {
          out.push(rec(0x205, Buffer.concat([at(), Buffer.from([cell.bool ? 1 : 0, 0])])));
        } else if ('label' in cell) {
          out.push(rec(0x204, Buffer.concat([at(), str16(cell.label)])));
        } else {
          out.push(rec(0xfd, Buffer.concat([at(), u32(cell.sst)])));
        }
      }
    });
    out.push(rec(0x0a));
    return Buffer.concat(out);
  });

  const names = sheets.map((sheet, i) => sheet.name ?? `Sheet${i + 1}`);
  const boundSheet = (i: number, offset: number) =>
    rec(
      0x85,
      Buffer.concat([
        u32(offset),
        Buffer.from([sheets[i]!.hidden ? 1 : 0, 0, names[i]!.length, wide(names[i]!) ? 1 : 0]),
        chars(names[i]!, wide(names[i]!)),
      ]),
    );
  const globals = (offsets: number[]) =>
    Buffer.concat([
      bof(opts.biffVersion ?? 0x0600, 0x0005),
      ...(opts.filepass ? [rec(0x2f, Buffer.alloc(6))] : []),
      rec(0x22, u16(opts.date1904 ? 1 : 0)),
      ...customFormats.map((format, i) => rec(0x41e, Buffer.concat([u16(164 + i), str16(format)]))),
      ...xfFormats.map((format) => rec(0xe0, Buffer.concat([u16(0, format), Buffer.alloc(16)]))),
      ...sheets.map((_, i) => boundSheet(i, offsets[i]!)),
      sharedStrings(strings, opts.sstChunk),
      rec(0x0a),
    ]);
  let offset = globals(sheets.map(() => 0)).length;
  const offsets = sheetStreams.map((stream) => {
    const at = offset;
    offset += stream.length;
    return at;
  });
  return Buffer.concat([globals(offsets), ...sheetStreams]);
}

/** A legacy Excel (.xls, BIFF8) file. */
export function buildXls(sheets: XlsSheet[], opts: XlsOptions = {}): Buffer {
  return buildCfb(buildWorkbookStream(sheets, opts));
}
