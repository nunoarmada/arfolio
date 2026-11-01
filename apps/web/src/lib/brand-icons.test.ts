import { describe, expect, it } from 'vitest';
import { faviconEntries, iconSvg, renderPng, type IconKind } from './brand-icons';
import { decodePng, type Png } from './test-png';

const TILE = '#1a6b7c';
const TILE_RGB = [0x1a, 0x6b, 0x7c];

async function render(kind: IconKind, hex = TILE): Promise<{ png: Png; bytes: number }> {
  const { svg, px } = iconSvg(kind, hex);
  const bytes = await renderPng(svg, px);
  return { png: decodePng(bytes), bytes: bytes.length };
}

const pixel = (png: Png, x: number, y: number) =>
  Array.from(png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));

describe('generated icons', () => {
  it('apple icon is 180px, fully opaque, with no baked corners', async () => {
    const { png, bytes } = await render('apple');
    expect([png.width, png.height]).toEqual([180, 180]);
    for (let i = 3; i < png.data.length; i += 4) expect(png.data[i]).toBe(255);
    expect(pixel(png, 0, 0).slice(0, 3)).toEqual(TILE_RGB);
    expect(pixel(png, 179, 179).slice(0, 3)).toEqual(TILE_RGB);
    expect(bytes).toBeLessThan(10 * 1024);
  });

  it('maskable icon is opaque and keeps the glyph inside the 80% safe zone', async () => {
    const { png, bytes } = await render('maskable');
    expect([png.width, png.height]).toEqual([512, 512]);
    const radius = 512 * 0.4;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const [r, g, b, a] = pixel(png, x, y) as [number, number, number, number];
        expect(a).toBe(255);
        const isTile =
          Math.abs(r - TILE_RGB[0]!) + Math.abs(g - TILE_RGB[1]!) + Math.abs(b - TILE_RGB[2]!) < 12;
        if (!isTile) expect(Math.hypot(x + 0.5 - 256, y + 0.5 - 256)).toBeLessThanOrEqual(radius);
      }
    }
    expect(bytes).toBeLessThan(30 * 1024);
  });

  it('any icons have round corners (transparent) and stay within their size budgets', async () => {
    const small = await render('192');
    const large = await render('512');
    expect([small.png.width, large.png.width]).toEqual([192, 512]);
    expect(pixel(small.png, 0, 0)[3]).toBe(0);
    expect(pixel(large.png, 256, 256)[3]).toBe(255);
    expect(small.bytes).toBeLessThan(10 * 1024);
    expect(large.bytes).toBeLessThan(30 * 1024);
  });

  it('badge is 96px, white on transparent and nothing else', async () => {
    const { png, bytes } = await render('badge');
    expect([png.width, png.height]).toEqual([96, 96]);
    let opaque = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const a = png.data[i + 3]!;
      if (a > 0) {
        opaque++;
        expect(Array.from(png.data.subarray(i, i + 3))).toEqual([255, 255, 255]);
      }
    }
    expect(opaque).toBeGreaterThan(1000);
    expect(pixel(png, 0, 0)[3]).toBe(0);
    expect(bytes).toBeLessThan(4 * 1024);
  });

  it('re-tints with the brand colour and uses the better glyph colour', async () => {
    const orange = await render('apple', '#c2410c');
    expect(pixel(orange.png, 0, 0).slice(0, 3)).toEqual([0xc2, 0x41, 0x0c]);
    const yellow = await render('apple', '#ffff00');
    // light tile: dark glyph, so some pixel is near-black
    const dark = Array.from({ length: 180 * 180 }, (_, i) => yellow.png.data[i * 4]!).some(
      (v) => v < 40,
    );
    expect(dark).toBe(true);
  });

  it('favicon entries are 16, 32 and 48 px', async () => {
    const entries = faviconEntries(TILE);
    expect(entries.map((e) => e.size)).toEqual([16, 32, 48]);
    for (const { size, svg } of entries) {
      const png = decodePng(await renderPng(svg, size));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(pixel(png, Math.floor(size / 2), Math.floor(size / 2))[3]).toBe(255);
    }
  });
});
