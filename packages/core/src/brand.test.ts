import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKGROUND, SURFACES, contrastRatio, deriveBrand, hexToOklch, oklchToHex } from './brand';

const SAMPLES: Record<string, string> = {
  teal: '#1a6b7c',
  yellow: '#ffee00',
  navy: '#0a1f5c',
  red: '#e02020',
  nearWhite: '#fafafa',
  nearBlack: '#0a0a0a',
  green: '#2e8b57',
  purple: '#7b2cbf',
  orange: '#ff8800',
  grey: '#808080',
};

describe('hexToOklch', () => {
  it('converts known colours', () => {
    const white = hexToOklch('#ffffff');
    expect(white.l).toBeCloseTo(1, 2);
    expect(white.c).toBeCloseTo(0, 2);
    const red = hexToOklch('#ff0000');
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.2577, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
  });

  it('round-trips through oklchToHex', () => {
    for (const hex of Object.values(SAMPLES)) {
      const { l, c, h } = hexToOklch(hex);
      expect(oklchToHex(l, c, h)).toBe(hex);
    }
  });

  it('rejects malformed hex values', () => {
    expect(() => hexToOklch('blue')).toThrow();
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
});

describe('deriveBrand', () => {
  it.each(Object.entries(SAMPLES))('derives accessible tokens for %s', (_name, hex) => {
    const brand = deriveBrand(hex);
    // Button text reaches AA in both modes, and the focus ring reaches 3:1 on the page background.
    expect(brand.light.contrast.buttonText).toBeGreaterThanOrEqual(4.5);
    expect(brand.dark.contrast.buttonText).toBeGreaterThanOrEqual(4.5);
    expect(brand.light.contrast.ring).toBeGreaterThanOrEqual(3);
    expect(brand.dark.contrast.ring).toBeGreaterThanOrEqual(3);
  });

  it('clamps lightness and chroma per mode while keeping the hue', () => {
    const brand = deriveBrand('#ffee00');
    const source = hexToOklch('#ffee00');
    const light = hexToOklch(brand.light.primaryHex);
    const dark = hexToOklch(brand.dark.primaryHex);
    expect(light.l).toBeGreaterThanOrEqual(0.41);
    expect(light.l).toBeLessThanOrEqual(0.58);
    expect(light.c).toBeLessThanOrEqual(0.19 + 0.005);
    expect(dark.l).toBeGreaterThanOrEqual(0.67);
    expect(dark.l).toBeLessThanOrEqual(0.81);
    expect(dark.c).toBeLessThanOrEqual(0.16 + 0.005);
    expect(Math.abs(light.h - source.h)).toBeLessThan(6);
    expect(brand.light.adjusted).toBe(true);
  });

  it('flags a colour that needed no adjustment', () => {
    const brand = deriveBrand('#1a6b7c');
    expect(brand.light.adjusted).toBe(false);
  });

  it('keeps the default Folio Cobalt as it is, with white above 6:1', () => {
    const brand = deriveBrand('#2F5BC2');
    expect(brand.light.adjusted).toBe(false);
    expect(brand.light.primaryForeground).toBe('#ffffff');
    expect(contrastRatio('#ffffff', '#2F5BC2')).toBeGreaterThan(6);
  });

  it('picks white or the dark foreground, whichever contrasts more', () => {
    expect(deriveBrand('#0a1f5c').light.primaryForeground).toBe('#ffffff');
    expect(deriveBrand('#0a1f5c').dark.primaryForeground).toBe(
      deriveBrand('#e02020').dark.primaryForeground,
    );
  });

  it('emits CSS oklch() values and a stylesheet for both modes', () => {
    const brand = deriveBrand('#1a6b7c');
    expect(brand.light.primary).toMatch(/^oklch\(0\.\d+ 0\.\d+ \d+(\.\d+)?\)$/);
    expect(brand.css).toContain(':root:root{');
    expect(brand.css).toContain(':root.dark{');
    expect(brand.css).toContain('--primary:');
    expect(brand.css).toContain('--primary-foreground:');
  });
});

// Design system v2 §3.3: extra tokens, checked for the six reference brands in both modes.
const V2_BRANDS: Record<string, string> = {
  teal: '#1a6b7c',
  navy: '#1e3a8a',
  orange: '#ea580c',
  purple: '#7c3aed',
  yellow: '#facc15',
  red: '#dc2626',
};

describe.each(Object.entries(V2_BRANDS))('deriveBrand v2 tokens for %s', (_name, hex) => {
  const brand = deriveBrand(hex);
  it.each(['light', 'dark'] as const)('%s: primary-text reads on surface and surface-2', (mode) => {
    const text = brand[mode].primaryTextHex;
    expect(contrastRatio(text, SURFACES[mode].surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(text, SURFACES[mode].surface2)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['light', 'dark'] as const)('%s: primary-foreground reads on primary', (mode) => {
    const m = brand[mode];
    const fg = m.primaryForeground;
    expect(contrastRatio(fg, m.primaryHex)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['light', 'dark'] as const)('%s: primary-foreground reads on primary-hover', (mode) => {
    const m = brand[mode];
    expect(contrastRatio(m.primaryForeground, m.primaryHoverHex)).toBeGreaterThanOrEqual(4.5);
  });
  it('emits theme-invariant tile tokens from the light mode only', () => {
    const [lightBlock, darkBlock] = brand.css.split(':root.dark{') as [string, string];
    expect(lightBlock).toContain(`--brand-tile:${brand.light.primary};`);
    expect(lightBlock).toContain(`--brand-tile-2:${brand.light.primary2};`);
    expect(lightBlock).toContain(`--brand-tile-foreground:${brand.light.primaryForeground};`);
    expect(darkBlock).not.toContain('--brand-tile');
  });
  it('emits hover, text, gradient partner and glow for both modes', () => {
    for (const token of [
      '--primary-hover:',
      '--primary-text:',
      '--primary-2:',
      '--primary-glow:',
    ]) {
      expect(brand.css.split(token)).toHaveLength(3);
    }
    expect(brand.light.primaryGlow).toMatch(/^oklch\(.+ \/ 0\.14\)$/);
    expect(brand.dark.primaryGlow).toMatch(/^oklch\(.+ \/ 0\.22\)$/);
  });
});

describe('deriveBrand v2 token directions', () => {
  const brand = deriveBrand('#1a6b7c');
  it('moves hover darker in light mode and lighter in dark mode', () => {
    expect(hexToOklch(brand.light.primaryHoverHex).l).toBeLessThan(
      hexToOklch(brand.light.primaryHex).l,
    );
    expect(hexToOklch(brand.dark.primaryHoverHex).l).toBeGreaterThan(
      hexToOklch(brand.dark.primaryHex).l,
    );
  });
  it('shifts the gradient partner hue by 18 degrees', () => {
    const base = hexToOklch(brand.light.primaryHex);
    const two = hexToOklch(brand.light.primary2Hex);
    expect(Math.abs(two.h - base.h - 18)).toBeLessThan(4);
  });
  it('leaves the CSS-derived soft tokens to the stylesheet', () => {
    expect(brand.css).not.toContain('--primary-soft');
  });
});

describe('server-side surface colours match globals.css', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../../apps/web/src/app/globals.css', import.meta.url)),
    'utf8',
  );
  /** The declarations of the first rule whose selector is exactly `selector`. */
  const block = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`No ${selector} block in globals.css`);
    return css.slice(start, css.indexOf('\n}', start));
  };
  const hexOf = (body: string, token: string): string => {
    const m = new RegExp(`--${token}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(body);
    if (!m) throw new Error(`--${token} is not a plain oklch() value`);
    return oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
  };
  it.each([
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const)('%s: BACKGROUND and SURFACES equal the stylesheet tokens', (mode, selector) => {
    const body = block(selector);
    expect(BACKGROUND[mode]).toBe(hexOf(body, 'background'));
    expect(SURFACES[mode].surface).toBe(hexOf(body, 'surface'));
    expect(SURFACES[mode].surface2).toBe(hexOf(body, 'surface-2'));
  });
});

describe('deriveBrand at the extremes', () => {
  it.each([
    ['black', '#000000'],
    ['white', '#ffffff'],
    ['mid grey', '#808080'],
  ])('%s: foregrounds and brand text stay readable in both modes', (_n, hex) => {
    const brand = deriveBrand(hex);
    for (const mode of ['light', 'dark'] as const) {
      const m = brand[mode];
      expect(contrastRatio(m.primaryForeground, m.primaryHex)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(m.primaryForeground, m.primaryHoverHex)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(m.primaryTextHex, SURFACES[mode].surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(m.primaryTextHex, SURFACES[mode].surface2)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
