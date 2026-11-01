import { describe, expect, it } from 'vitest';
import { mccLabel } from './mcc';

describe('mccLabel', () => {
  it('returns English and Portuguese labels for common codes', () => {
    expect(mccLabel('5411', 'en')).toBe('Grocery stores and supermarkets');
    expect(mccLabel('5411', 'pt')).toBe('Mercearias e supermercados');
    expect(mccLabel('5812', 'en')).toBe('Restaurants');
    expect(mccLabel('5814', 'pt')).toBe('Fast food');
  });

  it('returns Spanish, French and Italian labels', () => {
    expect(mccLabel('5411', 'es')).toBe('Tiendas de alimentación y supermercados');
    expect(mccLabel('5411', 'fr')).toBe('Épiceries et supermarchés');
    expect(mccLabel('5411', 'it')).toBe('Alimentari e supermercati');
    expect(mccLabel('3600', 'es')).toBe('Hoteles y alojamiento');
    expect(mccLabel('3050', 'fr')).toBe('Compagnies aériennes');
    expect(mccLabel('3400', 'it')).toBe('Noleggio auto');
  });

  it('resolves the airline and hotel ranges', () => {
    expect(mccLabel('3050', 'en')).toBe('Airlines');
    expect(mccLabel('4511', 'en')).toBe('Airlines');
    expect(mccLabel('3600', 'pt')).toBe('Hotéis e alojamento');
    expect(mccLabel('7011', 'en')).toBe('Hotels and lodging');
  });

  it('returns undefined for unknown, malformed or missing codes', () => {
    expect(mccLabel('0001', 'en')).toBeUndefined();
    expect(mccLabel('54', 'en')).toBeUndefined();
    expect(mccLabel(null, 'en')).toBeUndefined();
    expect(mccLabel(undefined, 'pt')).toBeUndefined();
  });
});
