# Arfolio brand

Identity assets for Arfolio. The app UI follows design system v2 (`docs/design/design-system-v2.md`); this folder only covers the mark, wordmark and marketing images.

## Files

| File | Use |
| --- | --- |
| `glyph.svg` | Arco glyph alone, 24-unit artboard, `currentColor` |
| `glyph-tile.svg` | Glyph on the Folio Cobalt tile (radius 0.22) |
| `wordmark.svg`, `wordmark-dark.svg` | "Arfolio" as outlines (Geist 600), for light and dark backgrounds |
| `lockup.svg`, `lockup-dark.svg` | Tile + wordmark, horizontal, clear space included |
| `src/` | Sources: `build-svgs.py` (SVGs), `hero.html` / `social.html` + `render.mjs` (PNGs) |

Raster outputs: `docs/images/hero.png` (1600x600 at 2x) and `.github/social-preview.png` (1280x640).

## The mark

"Arco": an archway holding a round weight. One union path on a 24-unit artboard, nonzero fill, no strokes. It is a shape, not a letter, so it survives `BRAND_NAME` changes. The 16 px favicon uses a pixel-snapped variant (`GLYPH_16` in `apps/web/src/lib/brand-glyph.ts`).

## Colour tokens

| Token | Value | Notes |
| --- | --- | --- |
| Folio Cobalt (`--primary`, light) | `#2F5BC2` | White on it: 6.18:1 |
| Primary, dark theme | `#6494FA` | Button text `#0F1216`, 6.40:1 |
| Gradient end (`--primary-2`) | `#5853B6` | Tile gradient 135deg, primary to primary-2 |
| Ink | `#0F1216` | Wordmark on light |
| Snow | `#F2F3F5` | Wordmark on dark |
| Marketing canvas | `#090A0D` | `oklch(0.145 0.006 260)` |

Flat cobalt tile in raster icons and the SVG masters; gradient in the app and marketing images.

## Wordmark and lockup

Geist 600, sentence case "Arfolio", tracking -0.02em, default kerning. With tile height H: text 0.56H (cap-height midpoint on the tile midpoint), gap 0.375H, clear space 0.5H on all sides, minimum H 20 px. Glyph sits at 0.6 of the tile side.

## Regenerating

The SVG masters and the marketing images are generated from `docs/brand/src`.

- `build-svgs.py` writes the wordmark and lockup SVGs with the text converted to outlines. Use a Python virtual environment with `fonttools`, `brotli` and `uharfbuzz` (`python -m venv .venv && .venv/bin/pip install fonttools brotli uharfbuzz`), then run `.venv/bin/python docs/brand/src/build-svgs.py node_modules/.pnpm/@fontsource-variable+geist@5.3.0/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2 docs/brand` (arguments: the variable Geist woff2 and the output directory).
- `render.mjs` renders `docs/images/hero.png` (1600x600 at 2x) and `.github/social-preview.png` (1280x640) from `hero.html` and `social.html`. Run `node docs/brand/src/render.mjs` from the repository root after `pnpm install`: it uses Playwright from `apps/web`, so it adds no dependency. Set `CHROMIUM=/path/to/chrome` if the bundled browser is missing.
- Both pages show `docs/images/screenshot-home-dark.png`: re-shoot the screenshots first, then render.

## Do and don't

- Do keep the clear space and the minimum size.
- Do use white glyph on cobalt, or the dark-background lockup on dark.
- Do not recolour the tile outside the brand colours, stretch, rotate, outline or add effects to the mark.
- Do not set the wordmark in another typeface, in capitals or with different tracking.
- Do not put the cobalt tile on a mid-blue background; use the dark lockup on dark surfaces.

## Rebranding a fork

The interface, titles, manifest and icons follow these environment variables:

| Variable | Purpose |
| --- | --- |
| `BRAND_NAME` | Product name shown in the UI |
| `BRAND_PRIMARY_COLOR` | Primary colour (tile, accents); the glyph colour is chosen for contrast |
| `BRAND_LOGO_URL` | Replaces the logo mark in the UI |

Without `BRAND_LOGO_URL` the default arch glyph is drawn on a tile in your primary colour.

## Licensing

The code is AGPL v3, but the "Arfolio" name and logo are not licensed for forks or modified versions; see [TRADEMARK.md](../../TRADEMARK.md). Rebrand with the variables above. Accurate references such as "forked from Arfolio" are fine.
