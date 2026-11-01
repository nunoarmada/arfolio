import { deriveBrand, oklchToHex, type BrandTokens } from '@arfolio/core';
import { getEnv } from './env';

export interface Brand {
  name: string;
  /** The raw configured colour: used for the logo/icon only, never for UI tokens. */
  primaryHex: string;
  logoUrl: string | undefined;
  tokens: BrandTokens;
}

/** Page background colours from the design tokens, for `theme-color` and the manifest. */
export const BACKGROUND_HEX = {
  light: oklchToHex(0.972, 0.003, 260),
  dark: oklchToHex(0.145, 0.006, 260),
};

/** Neutral colours of icons and social cards (design tokens, not brand colours). */
export const NEUTRAL_HEX = {
  canvas: '#f9fafb',
  foreground: '#16181d',
  muted: '#5f636a',
  white: '#ffffff',
  ink: '#111111',
} as const;

/** Installation branding, read from the environment (BRAND_NAME, BRAND_PRIMARY_COLOR, BRAND_LOGO_URL). */
export function getBrand(): Brand {
  const env = getEnv();
  return {
    name: env.BRAND_NAME,
    primaryHex: env.BRAND_PRIMARY_COLOR,
    logoUrl: env.BRAND_LOGO_URL,
    tokens: deriveBrand(env.BRAND_PRIMARY_COLOR),
  };
}
