import { contrastRatio } from '@arfolio/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  faviconSvg,
  pixelFaviconSvg,
  glyphColour,
  GLYPH_24,
  GLYPH_16,
  maskSvg,
  svgDataUri,
  tileSvg,
  TILE_RADIUS,
} from './brand-glyph';

const FIXTURES = [
  '#ffffff',
  '#000000',
  '#ffff00',
  '#000080',
  '#22c55e',
  '#c30fff',
  '#1a6b7c',
  '#2F5BC2',
];
const hex = (n: number) => n.toString(16).padStart(2, '0');
const GRID = [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255];
const grid = GRID.flatMap((r) =>
  GRID.flatMap((g) => GRID.map((b) => `#${hex(r)}${hex(g)}${hex(b)}`)),
);

describe('glyph geometry', () => {
  it('is the arch and the weight as two closed subpaths on the 24 grid', () => {
    expect(GLYPH_24.size).toBe(24);
    // Written in pieces so this file does not itself contain the geometry (see the next test).
    expect(GLYPH_24.path).toBe(
      [
        'M4 20V12A8 8 0',
        ' 0 1 20 12V20H16V12',
        'A4 4 0 0 0 8 12V20Z',
        'M9.75 16A2.25 2.25 0 1 0 14.25 16A2.25 2.25 0 1 0 9.75 16Z',
      ].join(''),
    );
    expect((GLYPH_24.path.match(/M/g) ?? []).length).toBe(2);
    expect((GLYPH_24.path.match(/Z/g) ?? []).length).toBe(2);
  });

  it('draws the 16-unit variant on whole pixels only', () => {
    expect(GLYPH_16.size).toBe(16);
    expect(GLYPH_16.tileRadius).toBe(3.5);
    expect(GLYPH_16.arch.path).toBe('M5 3h6v1h1v1h1v8h-2V6h-1V5H6v1H5v7H3V5h1V4h1Z');
    expect(GLYPH_16.weight.path).toBe('M7 10h2v2H7Z');
    for (const { path } of [GLYPH_16.arch, GLYPH_16.weight]) {
      expect(path).not.toMatch(/\d\.\d|[Aa]/);
    }
    expect('beam' in GLYPH_16).toBe(false);
  });

  it('exists in one source file only', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css|svg)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
    const owners = files.filter((f) =>
      readFileSync(f, 'utf8').includes(['M4 20V12A8 8', '0 0 1 20 12'].join(' ')),
    );
    expect(owners.map((f) => f.split('/').pop())).toEqual(['brand-glyph.ts']);
  });
});

describe('glyph colour on the tile', () => {
  it('puts a white glyph on the default Folio Cobalt at 6:1 or better', () => {
    expect(glyphColour('#2F5BC2')).toBe('#ffffff');
    expect(contrastRatio('#ffffff', '#2F5BC2')).toBeGreaterThan(6);
  });

  it('reaches 3:1 on the fixtures and a 16-step sRGB grid', () => {
    for (const tile of [...FIXTURES, ...grid]) {
      const fg = glyphColour(tile);
      expect(['#ffffff', '#111111']).toContain(fg);
      expect(contrastRatio(fg, tile), tile).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('svg builders', () => {
  it('keeps the favicon and the mask under 1 KB and free of styles', () => {
    for (const svg of [faviconSvg('#1a6b7c'), maskSvg()]) {
      expect(svg.length).toBeLessThan(1024);
      expect(svg).not.toMatch(/<style|@media/);
    }
    expect(faviconSvg('#1a6b7c')).toContain('fill="#1a6b7c"');
    expect(faviconSvg('#1a6b7c')).toContain(GLYPH_24.path);
    expect(pixelFaviconSvg('#1a6b7c')).toContain(GLYPH_16.arch.path);
    expect(pixelFaviconSvg('#1a6b7c')).toContain(GLYPH_16.weight.path);
    expect(pixelFaviconSvg('#1a6b7c')).not.toContain(GLYPH_24.path);
    expect(pixelFaviconSvg('#1a6b7c').length).toBeLessThan(1024);
    expect(maskSvg()).toContain('fill="#000"');
  });

  it('centres the glyph at the given scale and re-tints without changing geometry', () => {
    const a = tileSvg({
      px: 100,
      scale: 0.5,
      tile: { hex: '#111111', radius: TILE_RADIUS },
      glyph: '#fff',
    });
    const b = tileSvg({
      px: 100,
      scale: 0.5,
      tile: { hex: '#c2410c', radius: TILE_RADIUS },
      glyph: '#fff',
    });
    expect(a).toContain('translate(25 25) scale(2.083)');
    expect(a.replace('#111111', '#c2410c')).toBe(b);
    expect(a).toContain('rx="22"');
  });

  it('omits the tile for a bare glyph and builds data URIs', () => {
    expect(tileSvg({ px: 96, scale: 1, glyph: '#fff' })).not.toContain('<rect');
    expect(svgDataUri('<svg/>')).toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    );
  });
});
