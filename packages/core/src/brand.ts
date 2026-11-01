/**
 * Brand colour derivation (design system §2.2). The installation provides one hex colour; this
 * turns it into usable `--primary*` tokens for light and dark mode by clamping OKLCH lightness
 * and chroma while keeping the hue, then checks the contrast the design system promises.
 * Pure maths, no dependencies.
 */

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

type Rgb = [number, number, number];

const HEX = /^#([0-9a-f]{6})$/i;

function parseHex(hex: string): Rgb {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`Expected a #rrggbb colour, got "${hex}"`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return s * 255;
};

function linearToOklab([r, g, b]: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = parseHex(hex).map(toLinear) as Rgb;
  const [L, a, bb] = linearToOklab([r, g, b]);
  const c = Math.hypot(a, bb);
  const h = c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

const EPS = 1e-6;
const inGamut = (rgb: Rgb): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS);

function oklchToLinear(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad));
}

/** Largest chroma not above `c` that stays inside sRGB at this lightness and hue. */
function fitChroma(l: number, c: number, h: number): number {
  if (inGamut(oklchToLinear(l, c, h))) return c;
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(l, mid, h))) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function oklchToHex(l: number, c: number, h: number): string {
  const rgb = oklchToLinear(l, fitChroma(l, c, h), h)
    .map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v)))))))
    .map((v) => v.toString(16).padStart(2, '0'));
  return `#${rgb.join('')}`;
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
/** `oklch(0.18 0.01 260)`, the design system's dark foreground. */
const DARK_FG = oklchToHex(0.18, 0.01, 260);
/** Light and dark page backgrounds from the token block (`--background`, canvas). */
export const BACKGROUND = {
  light: oklchToHex(0.972, 0.003, 260),
  dark: oklchToHex(0.145, 0.006, 260),
};
/** Card and inset surfaces from the token block (`--surface`, `--surface-2`), per colour mode. */
export const SURFACES = {
  light: { surface: oklchToHex(1, 0, 260), surface2: oklchToHex(0.962, 0.004, 260) },
  dark: { surface: oklchToHex(0.19, 0.007, 260), surface2: oklchToHex(0.225, 0.008, 260) },
} as const;

const fmt = (n: number, digits: number): string => String(Number(n.toFixed(digits)));
const css = (l: number, c: number, h: number): string =>
  `oklch(${fmt(l, 3)} ${fmt(c, 3)} ${fmt(h, 1)})`;

export interface BrandMode {
  /** CSS value for `--primary`. */
  primary: string;
  primaryHex: string;
  /** CSS value for `--primary-foreground`. */
  primaryForeground: string;
  /** `--primary-hover`: one step darker (light) or lighter (dark) than `--primary`. */
  primaryHover: string;
  primaryHoverHex: string;
  /** `--primary-text`: links and active nav labels; ≥4.5:1 on surface and surface-2. */
  primaryText: string;
  primaryTextHex: string;
  /** `--primary-2`: gradient partner (hue +18°, chroma ×0.9). */
  primary2: string;
  primary2Hex: string;
  /** `--primary-glow`: the primary at low alpha, for hero glows and chart areas. */
  primaryGlow: string;
  /** True when clamping changed the brand colour's lightness or chroma. */
  adjusted: boolean;
  contrast: { buttonText: number; ring: number };
}

export interface BrandTokens {
  hue: number;
  light: BrandMode;
  dark: BrandMode;
  /** `:root{...}.dark{...}` declarations for the brand-driven tokens, ready for a <style> tag. */
  css: string;
}

const RANGES = {
  light: { minL: 0.42, maxL: 0.58, maxC: 0.19 },
  dark: { minL: 0.68, maxL: 0.8, maxC: 0.16 },
} as const;

function deriveMode(source: Oklch, mode: 'light' | 'dark'): BrandMode {
  const { minL, maxL, maxC } = RANGES[mode];
  const h = source.h;
  let l = Math.min(maxL, Math.max(minL, source.l));
  const c = Math.min(maxC, source.c);

  const pick = (lightness: number) => {
    const hex = oklchToHex(lightness, c, h);
    const white = contrastRatio(WHITE, hex);
    const dark = contrastRatio(DARK_FG, hex);
    return white >= dark ? { hex, fg: WHITE, ratio: white } : { hex, fg: DARK_FG, ratio: dark };
  };

  let chosen = pick(l);
  // At the top of the light range neither foreground reaches 4.5:1: darken until one does.
  while (chosen.ratio < 4.5 && mode === 'light' && l > minL) {
    l = Math.max(minL, l - 0.01);
    chosen = pick(l);
  }
  // The same, brightening, for the bottom of the dark range.
  while (chosen.ratio < 4.5 && mode === 'dark' && l < maxL) {
    l = Math.min(maxL, l + 0.01);
    chosen = pick(l);
  }

  const outC = fitChroma(l, c, h);

  // Hover keeps the text on the button readable: shrink the step until it still reaches 4.5:1.
  const hoverStep = mode === 'light' ? -0.05 : 0.04;
  let hoverL = l + hoverStep;
  const hoverAt = (x: number) => oklchToHex(x, outC, h);
  while (Math.abs(hoverL - l) > 0.005 && contrastRatio(chosen.fg, hoverAt(hoverL)) < 4.5) {
    hoverL -= Math.sign(hoverStep) * 0.005;
  }
  const hoverC = fitChroma(hoverL, outC, h);

  // Text colour: light mode caps lightness at 0.50, dark mode floors it at 0.76; then keep
  // moving until it reads on both the card and the inset surface.
  const { surface, surface2 } = SURFACES[mode];
  const readable = (hex: string) =>
    Math.min(contrastRatio(hex, surface), contrastRatio(hex, surface2)) >= 4.5;
  let textL = mode === 'light' ? Math.min(l, 0.5) : Math.max(l, 0.76);
  const textAt = (x: number) => oklchToHex(x, fitChroma(x, outC, h), h);
  while (!readable(textAt(textL)) && textL > 0.2 && textL < 0.95) {
    textL += mode === 'light' ? -0.01 : 0.01;
  }
  const textC = fitChroma(textL, outC, h);

  const h2 = (h + 18) % 360;
  const c2 = fitChroma(l, outC * 0.9, h2);
  const alpha = mode === 'light' ? 0.14 : 0.22;

  return {
    primary: css(l, outC, h),
    primaryHex: chosen.hex,
    primaryForeground: chosen.fg,
    primaryHover: css(hoverL, hoverC, h),
    primaryHoverHex: hoverAt(hoverL),
    primaryText: css(textL, textC, h),
    primaryTextHex: textAt(textL),
    primary2: css(l, c2, h2),
    primary2Hex: oklchToHex(l, c2, h2),
    primaryGlow: `oklch(${fmt(l, 3)} ${fmt(outC, 3)} ${fmt(h, 1)} / ${alpha})`,
    adjusted: Math.abs(l - source.l) > 0.005 || Math.abs(outC - source.c) > 0.005,
    contrast: {
      buttonText: chosen.ratio,
      ring: contrastRatio(chosen.hex, BACKGROUND[mode]),
    },
  };
}

/** Derives the brand-driven tokens for both colour modes from one hex colour. */
export function deriveBrand(hex: string): BrandTokens {
  const source = hexToOklch(hex);
  const light = deriveMode(source, 'light');
  const dark = deriveMode(source, 'dark');
  // The soft/border/gradient tokens are CSS-derived from these in globals.css.
  const block = (m: BrandMode) =>
    `--primary:${m.primary};--primary-foreground:${m.primaryForeground};` +
    `--primary-hover:${m.primaryHover};--primary-text:${m.primaryText};` +
    `--primary-2:${m.primary2};--primary-glow:${m.primaryGlow};`;
  const tile = (m: BrandMode) =>
    `--brand-tile:${m.primary};--brand-tile-2:${m.primary2};--brand-tile-foreground:${m.primaryForeground};`;
  return {
    hue: source.h,
    light,
    dark,
    // The mark is identity, not theme: its tile always uses the light-mode tokens (no dark override).
    css: `:root:root{${block(light)}${tile(light)}}:root.dark{${block(dark)}}`,
  };
}
