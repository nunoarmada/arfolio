import { contrastRatio } from '@arfolio/core';
import { NEUTRAL_HEX } from './brand';

/**
 * The Arco mark: a thick archway (the household) holding a round weight. This file is the single
 * source of its geometry; every generated icon, the SVG favicon and the in-app BrandMark draw from
 * it. Pure data and string builders, so it runs in route handlers, components and tests alike.
 */

/** Master glyph on a 24-unit artboard: two closed subpaths (nonzero), no strokes. */
export const GLYPH_24 = {
  size: 24,
  /** Arch (x 4-20, y 4-20, 4 units thick, flat feet), then weight (circle r 2.25 at 12,16). */
  path: 'M4 20V12A8 8 0 0 1 20 12V20H16V12A4 4 0 0 0 8 12V20ZM9.75 16A2.25 2.25 0 1 0 14.25 16A2.25 2.25 0 1 0 9.75 16Z',
} as const;

/** Pixel-snapped variant for the 16px favicon, drawn on the tile grid (tile 0-16), nothing anti-aliased. */
export const GLYPH_16 = {
  size: 16,
  tileRadius: 3.5,
  /** Arch: row 3 x5-11, row 4 x4-12, row 5 x3-6 and x10-13, rows 6-12 x3-5 and x11-13. */
  arch: { path: 'M5 3h6v1h1v1h1v8h-2V6h-1V5H6v1H5v7H3V5h1V4h1Z' },
  /** Weight: a 2x2 block at (7,10). */
  weight: { path: 'M7 10h2v2H7Z' },
} as const;

/** Share of the tile side taken by the 24-unit artboard, per use. */
export const GLYPH_SCALE = {
  ui: 0.6,
  favicon: 0.75,
  apple: 0.6,
  pwa: 0.62,
  maskable: 0.5,
  badge: 1,
  og: 0.6,
} as const;

/** Tile corner radius as a share of its side (design system radii: 8px at 36, 10px at 48). */
export const TILE_RADIUS = 0.22;

/** White or near-black, whichever reads better on the tile colour (at least 3:1 for any colour). */
export function glyphColour(tileHex: string): typeof NEUTRAL_HEX.white | typeof NEUTRAL_HEX.ink {
  const { white, ink } = NEUTRAL_HEX;
  return contrastRatio(white, tileHex) >= contrastRatio(ink, tileHex) ? white : ink;
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

/** The 16-unit pixel-snapped favicon (tile in the raw brand colour). Only for the 16x16 PNG inside favicon.ico. */
export function pixelFaviconSvg(tileHex: string): string {
  const { arch, weight, tileRadius } = GLYPH_16;
  const fg = glyphColour(tileHex);
  return (
    `<svg ${SVG_NS} viewBox="0 0 16 16">` +
    `<rect width="16" height="16" rx="${tileRadius}" fill="${tileHex}"/>` +
    `<path fill="${fg}" d="${arch.path}${weight.path}"/>` +
    `</svg>`
  );
}

/** Pinned-tab mask: the master glyph alone, single path, black. The colour comes from the link. */
export function maskSvg(): string {
  return `<svg ${SVG_NS} viewBox="0 0 24 24"><path fill="#000" d="${GLYPH_24.path}"/></svg>`;
}

/** The master glyph as a standalone svg string with a given fill and pixel size. */
export function glyphSvg(fill: string, px: number): string {
  return `<svg ${SVG_NS} width="${px}" height="${px}" viewBox="0 0 24 24"><path fill="${fill}" d="${GLYPH_24.path}"/></svg>`;
}

const round = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * A square icon of `px` pixels as an svg string: an optional tile (corner radius as a share of the
 * side; 0 for full-bleed) and the master glyph centred at `scale` of the side. Without a tile the
 * glyph is drawn alone (badge, mask). Used for every raster icon and the OG tile.
 */
export function tileSvg(options: {
  px: number;
  scale: number;
  tile?: { hex: string; radius: number };
  glyph: string;
}): string {
  const { px, scale, tile, glyph } = options;
  const artboard = px * scale;
  const offset = (px - artboard) / 2;
  const rect = tile
    ? `<rect width="${px}" height="${px}" rx="${round(px * tile.radius)}" fill="${tile.hex}"/>`
    : '';
  return (
    `<svg ${SVG_NS} width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">${rect}` +
    `<path fill="${glyph}" transform="translate(${round(offset)} ${round(offset)}) scale(${round(artboard / GLYPH_24.size)})" d="${GLYPH_24.path}"/></svg>`
  );
}

/** An svg string as a data URI an `<img>` can carry (what Satori renders). */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * `/icon.svg`: smooth master glyph at 75% of a 32-unit tile (browsers show it at 32px and up on
 * HiDPI; the hand-pixelled variant would look blocky there). Tile in the raw brand colour.
 */
export function faviconSvg(tileHex: string): string {
  return tileSvg({
    px: 32,
    scale: GLYPH_SCALE.favicon,
    tile: { hex: tileHex, radius: TILE_RADIUS },
    glyph: glyphColour(tileHex),
  });
}
