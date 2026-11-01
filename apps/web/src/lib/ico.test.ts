import { describe, expect, it } from 'vitest';
import { packIco } from './ico';

const png = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('packIco', () => {
  it('writes a valid ICONDIR, entries and payloads', () => {
    const ico = packIco([
      { size: 16, png: png(10, 1) },
      { size: 32, png: png(20, 2) },
      { size: 48, png: png(30, 3) },
    ]);
    const view = new DataView(ico.buffer);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([
      0, 1, 3,
    ]);
    const headerSize = 6 + 3 * 16;
    expect(ico.length).toBe(headerSize + 60);
    const entries = [0, 1, 2].map((i) => {
      const e = 6 + i * 16;
      return {
        width: view.getUint8(e),
        height: view.getUint8(e + 1),
        planes: view.getUint16(e + 4, true),
        bpp: view.getUint16(e + 6, true),
        bytes: view.getUint32(e + 8, true),
        offset: view.getUint32(e + 12, true),
      };
    });
    expect(entries).toEqual([
      { width: 16, height: 16, planes: 1, bpp: 32, bytes: 10, offset: headerSize },
      { width: 32, height: 32, planes: 1, bpp: 32, bytes: 20, offset: headerSize + 10 },
      { width: 48, height: 48, planes: 1, bpp: 32, bytes: 30, offset: headerSize + 30 },
    ]);
    expect(ico[headerSize]).toBe(1);
    expect(ico[headerSize + 10]).toBe(2);
    expect(ico[headerSize + 30]).toBe(3);
  });

  it('stores 256 as 0', () => {
    const ico = packIco([{ size: 256, png: png(4, 9) }]);
    expect([ico[6], ico[7]]).toEqual([0, 0]);
  });

  it('rejects an empty list and out-of-range sizes', () => {
    expect(() => packIco([])).toThrow(RangeError);
    expect(() => packIco([{ size: 0, png: png(1, 0) }])).toThrow(RangeError);
    expect(() => packIco([{ size: 257, png: png(1, 0) }])).toThrow(RangeError);
    expect(() => packIco([{ size: 16.5, png: png(1, 0) }])).toThrow(RangeError);
  });
});
