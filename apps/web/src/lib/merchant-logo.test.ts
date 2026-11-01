import { afterEach, describe, expect, it } from 'vitest';
import {
  hasLogoFailed,
  markLogoFailed,
  merchantLogoUrl,
  resetFailedLogos,
  shouldRequestLogo,
} from './merchant-logo';

afterEach(resetFailedLogos);

describe('merchant logo requests', () => {
  it('points at the same-origin logo route', () => {
    expect(merchantLogoUrl('abc')).toBe('/api/merchants/abc/logo');
  });

  it('never requests a logo for a merchant without one, or without a merchant', () => {
    expect(shouldRequestLogo({ id: 'a', hasLogo: false })).toBe(false);
    expect(shouldRequestLogo(null)).toBe(false);
    expect(shouldRequestLogo(undefined)).toBe(false);
    expect(shouldRequestLogo({ id: 'a', hasLogo: true })).toBe(true);
  });

  it('forgets a failure after ten minutes', () => {
    markLogoFailed('a', 1_000);
    expect(hasLogoFailed('a', 1_000 + 9 * 60_000)).toBe(true);
    expect(hasLogoFailed('a', 1_000 + 10 * 60_000)).toBe(false);
  });

  it('does not ask again for a logo that failed (remounted virtual rows)', () => {
    markLogoFailed('a');
    expect(hasLogoFailed('a')).toBe(true);
    expect(shouldRequestLogo({ id: 'a', hasLogo: true })).toBe(false);
    expect(shouldRequestLogo({ id: 'b', hasLogo: true })).toBe(true);
  });
});
