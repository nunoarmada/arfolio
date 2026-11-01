import { inflateSync } from 'node:zlib';

export interface Png {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Minimal PNG decoder for tests: 8-bit, non-interlaced, grey/RGB/RGBA/palette-free output as RGBA. */
export function decodePng(bytes: Uint8Array): Png {
  const buf = Buffer.from(bytes);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0)
        throw new Error('unsupported PNG (need 8-bit, no interlace)');
      colourType = body[9]!;
    } else if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? rows[y * stride + x - channels]! : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? rows[(y - 1) * stride + x - channels]! : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]!;
      rows[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const [r, g, b, a] =
      channels === 4
        ? [rows[p]!, rows[p + 1]!, rows[p + 2]!, rows[p + 3]!]
        : channels === 3
          ? [rows[p]!, rows[p + 1]!, rows[p + 2]!, 255]
          : channels === 2
            ? [rows[p]!, rows[p]!, rows[p]!, rows[p + 1]!]
            : [rows[p]!, rows[p]!, rows[p]!, 255];
    data.set([r, g, b, a], i * 4);
  }
  return { width, height, data };
}
