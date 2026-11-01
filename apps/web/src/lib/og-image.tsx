import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import enMessages from '../../messages/en.json';
import esMessages from '../../messages/es-ES.json';
import frMessages from '../../messages/fr-FR.json';
import itMessages from '../../messages/it-IT.json';
import ptMessages from '../../messages/pt-PT.json';
import { FALLBACK_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from '@/i18n/locales';
import { getBrand, NEUTRAL_HEX } from './brand';
import { glyphColour, GLYPH_SCALE, svgDataUri, tileSvg, TILE_RADIUS } from './brand-glyph';
import { ICON_CACHE } from './brand-icons';

const TAGLINES: Record<Locale, string> = {
  'pt-PT': ptMessages.brand.tagline,
  'es-ES': esMessages.brand.tagline,
  'fr-FR': frMessages.brand.tagline,
  'it-IT': itMessages.brand.tagline,
  en: enMessages.brand.tagline,
};

// Satori reads static TTF/OTF/WOFF only (not WOFF2, not variable fonts), so the OG image uses
// vendored static Geist files. They are read from disk relative to the app directory (the
// working directory of both `next start` and the standalone server) and next.config.ts lists them
// in outputFileTracingIncludes so the standalone build ships them.
const fontDir = () => join(process.cwd(), 'src', 'assets', 'fonts');
let fonts: Promise<[Buffer, Buffer]> | undefined;
const loadFonts = () =>
  (fonts ??= Promise.all([
    readFile(join(fontDir(), 'geist-latin-400-normal.woff')),
    readFile(join(fontDir(), 'geist-latin-600-normal.woff')),
  ]).catch((error: unknown) => {
    fonts = undefined;
    throw error;
  }));

/** Locale of the card: `?lang=`, else the visitor's language cookie, else the installation default. */
export function ogLocale(request: Request): Locale {
  const param = new URL(request.url).searchParams.get('lang');
  if (isLocale(param)) return param;
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === LOCALE_COOKIE)?.[1];
  if (isLocale(cookie)) return cookie;
  const configured = process.env.DEFAULT_LOCALE;
  return isLocale(configured) ? configured : FALLBACK_LOCALE;
}

/**
 * Auto-fit: up to 12 characters at 96px, 13-22 at 72px, 23-30 at 60px. Longer names are cut at a
 * word boundary (or hard, for one long word) and end with an ellipsis, at most 30 characters.
 */
export function ogName(name: string): { text: string; fontSize: number } {
  const chars = Array.from(name.trim());
  if (chars.length <= 12) return { text: chars.join(''), fontSize: 96 };
  if (chars.length <= 22) return { text: chars.join(''), fontSize: 72 };
  if (chars.length <= 30) return { text: chars.join(''), fontSize: 60 };
  const head = chars.slice(0, 29);
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? head.slice(0, space) : head;
  return { text: `${cut.join('').trimEnd()}…`, fontSize: 60 };
}

const OG_WIDTH = 1200;

/** Open Graph (1200x630) and Twitter (1200x600) card: tile, name and tagline on the canvas. */
export async function renderOg(request: Request, height: 630 | 600): Promise<ImageResponse> {
  const brand = getBrand();
  const locale = ogLocale(request);
  const s = height / 630;
  const name = ogName(brand.name);
  const tile = Math.round(112 * s);
  const [regular, semibold] = await loadFonts();
  const mark = svgDataUri(
    tileSvg({
      px: tile,
      scale: GLYPH_SCALE.og,
      tile: { hex: brand.primaryHex, radius: TILE_RADIUS },
      glyph: glyphColour(brand.primaryHex),
    }),
  );
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: NEUTRAL_HEX.canvas,
        fontFamily: 'Geist',
      }}
    >
      <img
        src={mark}
        width={tile}
        height={tile}
        alt=""
        style={{ position: 'absolute', left: 96, top: Math.round(150 * s) }}
      />
      <div
        style={{
          position: 'absolute',
          left: 96,
          top: Math.round(310 * s),
          width: OG_WIDTH - 192,
          display: 'flex',
          fontSize: name.fontSize,
          lineHeight: 1,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: NEUTRAL_HEX.foreground,
          whiteSpace: 'nowrap',
        }}
      >
        {name.text}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 96,
          top: Math.round((310 + name.fontSize + 40) * s),
          width: 900,
          display: 'flex',
          fontSize: 36,
          lineHeight: 1.2,
          fontWeight: 400,
          color: NEUTRAL_HEX.muted,
          whiteSpace: 'nowrap',
        }}
      >
        {TAGLINES[locale]}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          height: 12,
          background: brand.primaryHex,
        }}
      />
    </div>,
    {
      width: OG_WIDTH,
      height,
      fonts: [
        { name: 'Geist', data: regular, weight: 400, style: 'normal' },
        { name: 'Geist', data: semibold, weight: 600, style: 'normal' },
      ],
      headers: { 'Cache-Control': ICON_CACHE, Vary: 'Cookie' },
    },
  );
}
