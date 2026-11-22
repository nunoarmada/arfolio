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

function dirEntry(name: string, type: number, child: number, start: number, size: number): Buffer {
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
  return entry;
}

export interface CfbOptions {
  /** Stream name; Excel writes `Workbook`. */
  name?: string;
  /** Store the stream in the mini stream (default: whenever it is under 4096 bytes). */
  mini?: boolean;
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
      dirEntry(opts.name ?? 'Workbook', 2, FREE, 0, stream.length),
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
