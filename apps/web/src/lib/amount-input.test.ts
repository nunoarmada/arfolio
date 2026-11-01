import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { parsePlanned, tidyPlannedInput, toPlannedInput } from './amount-input';

describe('parsePlanned', () => {
  it('reads pt-PT and en amounts, and empty as zero', () => {
    expect(parsePlanned('')).toEqual({ ok: true, minor: 0 });
    expect(parsePlanned('  ')).toEqual({ ok: true, minor: 0 });
    expect(parsePlanned('120,50')).toEqual({ ok: true, minor: 12050 });
    expect(parsePlanned('120.50')).toEqual({ ok: true, minor: 12050 });
    expect(parsePlanned('1 200,50')).toEqual({ ok: true, minor: 120050 });
    expect(parsePlanned('1,200.50')).toEqual({ ok: true, minor: 120050 });
    expect(parsePlanned('1.200,5')).toEqual({ ok: true, minor: 120050 });
    expect(parsePlanned('85')).toEqual({ ok: true, minor: 8500 });
    expect(parsePlanned('85 €')).toEqual({ ok: true, minor: 8500 });
  });

  it('reads amounts as every app locale displays them, currency included', () => {
    for (const locale of LOCALES) {
      for (const style of ['decimal', 'currency'] as const) {
        const shown = new Intl.NumberFormat(locale, {
          style,
          currency: 'EUR',
          minimumFractionDigits: 2,
        }).format(12345.67);
        expect(parsePlanned(shown), `${locale} ${shown}`).toEqual({ ok: true, minor: 1234567 });
      }
    }
  });

  it('refuses negatives and nonsense with a reason', () => {
    expect(parsePlanned('-5')).toEqual({ ok: false, reason: 'negative' });
    expect(parsePlanned('abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePlanned('1,2,3')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePlanned('12.345678')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('toPlannedInput', () => {
  it('writes the amount the way the locale types it and round-trips', () => {
    expect(toPlannedInput(0, 'pt-PT')).toBe('');
    expect(toPlannedInput(12050, 'pt-PT')).toBe('120,50');
    expect(toPlannedInput(12050, 'en')).toBe('120.50');
    expect(toPlannedInput(8500, 'pt-PT')).toBe('85');
    expect(toPlannedInput(5, 'en')).toBe('0.05');
    for (const minor of [1, 99, 100, 12050, 120050, 99999999]) {
      for (const locale of LOCALES) {
        expect(parsePlanned(toPlannedInput(minor, locale))).toEqual({ ok: true, minor });
      }
    }
  });
});

describe('tidyPlannedInput', () => {
  it('rewrites a valid amount the way toPlannedInput types it', () => {
    expect(tidyPlannedInput('3 000,5', 'pt-PT')).toBe('3000,50');
    expect(tidyPlannedInput('120.5', 'en')).toBe('120.50');
    expect(tidyPlannedInput('85,00', 'pt-PT')).toBe('85');
    expect(tidyPlannedInput('0', 'pt-PT')).toBe('');
  });

  it('leaves invalid or negative input to the validator', () => {
    expect(tidyPlannedInput('abc', 'pt-PT')).toBeNull();
    expect(tidyPlannedInput('-5', 'pt-PT')).toBeNull();
  });
});
