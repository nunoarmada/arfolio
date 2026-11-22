import { ValidationError } from '../context.js';

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
    if (!entry || !root) throw notXls();
    const start = entry.readUInt32LE(116);
    const length = entry.readUInt32LE(120);
    if (entry.readUInt32LE(124) !== 0 || length > buf.length) throw notXls();

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
