import { describe, expect, it } from 'vitest';
import { countryOptions, defaultCountry, isBankCountry } from './countries';

describe('defaultCountry', () => {
  it('uses the region of the household locale', () => {
    expect(defaultCountry('pt-PT', null)).toBe('PT');
    expect(defaultCountry('en-GB', 'ES')).toBe('GB');
  });

  it('falls back to the latest connection for a language-only locale, else nothing', () => {
    expect(defaultCountry('en', 'ES')).toBe('ES');
    expect(defaultCountry('en', null)).toBeNull();
    expect(defaultCountry('en', 'ZZ')).toBeNull();
  });
});

describe('countryOptions', () => {
  it('names countries in the locale and sorts them by it', () => {
    const pt = countryOptions('pt-PT');
    expect(pt.find((c) => c.code === 'PT')?.name).toBe('Portugal');
    expect(pt.find((c) => c.code === 'DE')?.name).toBe('Alemanha');
    const names = pt.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'pt-PT')));
    expect(isBankCountry('PT')).toBe(true);
    expect(isBankCountry('XX')).toBe(false);
  });
});
