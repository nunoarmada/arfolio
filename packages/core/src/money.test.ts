import { describe, expect, it } from 'vitest';
import { formatMoney, minorDecimal, minorDigits } from './money';

const plain = (s: string) => s.replace(/[\s\u00a0\u202f]/g, ' ');

describe('formatMoney', () => {
  it('matches Intl output with always-on grouping for pt-PT', () => {
    const expected = new Intl.NumberFormat('pt-PT', {
      style: 'currency',
      currency: 'EUR',
      useGrouping: 'always',
    }).format(1234.56);
    expect(formatMoney(123456, 'EUR', 'pt-PT')).toBe(expected);
  });

  it('groups four-digit pt-PT amounts, which plain Intl leaves ungrouped', () => {
    expect(plain(formatMoney(123456, 'EUR', 'pt-PT'))).toBe('1 234,56 €');
    expect(plain(formatMoney(123456789, 'EUR', 'pt-PT'))).toBe('1 234 567,89 €');
    expect(plain(formatMoney(99999, 'EUR', 'pt-PT'))).toBe('999,99 €');
  });

  it('formats en amounts with the symbol first', () => {
    expect(formatMoney(123456, 'EUR', 'en')).toBe('€1,234.56');
  });

  it('keeps a minus sign and two decimals for negative amounts', () => {
    const out = formatMoney(-500, 'EUR', 'en');
    expect(out).toContain('-');
    expect(out).toContain('5.00');
  });

  it('formats zero with two decimals', () => {
    expect(plain(formatMoney(0, 'EUR', 'pt-PT'))).toBe('0,00 €');
  });

  it('uses the currency exponent: zero-decimal currencies are not divided by 100', () => {
    expect(plain(formatMoney(1500, 'JPY', 'en'))).toBe('¥1,500');
  });

  it('accepts bigint minor units', () => {
    expect(plain(formatMoney(123456n, 'EUR', 'pt-PT'))).toBe('1 234,56 €');
  });

  it('supports compact notation with at most one decimal', () => {
    expect(formatMoney(12_000_00, 'EUR', 'en', { compact: true })).toBe('€12K');
    expect(formatMoney(123_000_00, 'EUR', 'en', { compact: true })).toBe('€123K');
  });

  it('rejects non-integer minor units', () => {
    expect(() => formatMoney(12.5, 'EUR', 'en')).toThrow(/safe integer/);
  });
});

describe('minorDigits', () => {
  it('gives the ISO 4217 minor-unit digits of a currency', () => {
    expect(minorDigits('EUR')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KWD', 'pt-PT')).toBe(3);
  });
});

describe('minorDecimal', () => {
  it('writes minor units as an exact plain decimal for the currency', () => {
    expect(minorDecimal(123_456, 'EUR')).toBe('1234.56');
    expect(minorDecimal(-5, 'EUR')).toBe('-0.05');
    expect(minorDecimal(0, 'EUR')).toBe('0.00');
    expect(minorDecimal(1234, 'JPY')).toBe('1234');
    expect(minorDecimal(-1500, 'KWD')).toBe('-1.500');
  });

  it('is exact beyond the float range', () => {
    expect(minorDecimal(12_345_678_901_234_567_890n, 'EUR')).toBe('123456789012345678.90');
  });
});
