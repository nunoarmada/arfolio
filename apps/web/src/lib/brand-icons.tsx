import { ImageResponse } from 'next/og';
import {
  pixelFaviconSvg,
  glyphColour,
  GLYPH_SCALE,
  svgDataUri,
  tileSvg,
  TILE_RADIUS,
} from './brand-glyph';
import { getBrand, NEUTRAL_HEX } from './brand';

export const ICON_CACHE = 'public, max-age=3600';

/** Raster icon variants served from `/icons/[size]` (single source of geometry: brand-glyph.ts). */
export type IconKind = '192' | '512' | 'maskable' | 'apple' | 'badge';

export function isIconKind(value: string): value is IconKind {
  return ['192', '512', 'maskable', 'apple', 'badge'].includes(value);
}

/** The svg for a variant. PNG renderers and tests both start from here. */
export function iconSvg(kind: IconKind, tileHex: string): { svg: string; px: number } {
  const fg = glyphColour(tileHex);
  switch (kind) {
    case '192':
    case '512': {
      const px = Number(kind);
      return {
        px,
        svg: tileSvg({
          px,
          scale: GLYPH_SCALE.pwa,
          tile: { hex: tileHex, radius: TILE_RADIUS },
          glyph: fg,
        }),
      };
    }
    // Full-bleed, opaque, no baked corners: iOS and Android mask the icon themselves. The maskable
    // glyph stays well inside the central 80% safe zone (40% radius).
    case 'maskable':
      return {
        px: 512,
        svg: tileSvg({
          px: 512,
          scale: GLYPH_SCALE.maskable,
          tile: { hex: tileHex, radius: 0 },
          glyph: fg,
        }),
      };
    case 'apple':
      return {
        px: 180,
        svg: tileSvg({
          px: 180,
          scale: GLYPH_SCALE.apple,
          tile: { hex: tileHex, radius: 0 },
          glyph: fg,
        }),
      };
    // Notification badge: white glyph on transparent, no tile.
    case 'badge':
      return {
        px: 96,
        svg: tileSvg({ px: 96, scale: GLYPH_SCALE.badge, glyph: NEUTRAL_HEX.white }),
      };
  }
}

function asImage(svg: string, px: number): ImageResponse {
  return new ImageResponse(<img src={svgDataUri(svg)} width={px} height={px} alt="" />, {
    width: px,
    height: px,
    headers: { 'Cache-Control': ICON_CACHE },
  });
}

export function renderIcon(kind: IconKind): ImageResponse {
  const { svg, px } = iconSvg(kind, getBrand().primaryHex);
  return asImage(svg, px);
}

/** The three favicon.ico entries: 16 (pixel-snapped variant), 32 and 48 (master glyph at 75%). */
export function faviconEntries(tileHex: string): { size: number; svg: string }[] {
  const fg = glyphColour(tileHex);
  return [
    { size: 16, svg: pixelFaviconSvg(tileHex) },
    ...[32, 48].map((size) => ({
      size,
      svg: tileSvg({
        px: size,
        scale: GLYPH_SCALE.favicon,
        tile: { hex: tileHex, radius: TILE_RADIUS },
        glyph: fg,
      }),
    })),
  ];
}

export async function renderPng(svg: string, px: number): Promise<Uint8Array> {
  return new Uint8Array(await asImage(svg, px).arrayBuffer());
}
