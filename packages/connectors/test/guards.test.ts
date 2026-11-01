import { describe, expect, it } from 'vitest';
import { currencyExponent, minorFromDecimalString, minorFromNumber } from '../src/guards.js';
import { ProviderResponseError } from '../src/types.js';

describe('currencyExponent', () => {
  it('uses the ISO 4217 exponent', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it.each(['', 'EU', 'EURO', '12!', 'E UR'])('rejects the invalid code %j', (code) => {
    expect(() => currencyExponent(code)).toThrow(ProviderResponseError);
  });
});

describe('minorFromDecimalString', () => {
  it.each([
    ['1000', 'JPY', 1000],
    ['12.34', 'EUR', 1234],
    ['1.234', 'KWD', 1234],
    ['-12.34', 'EUR', -1234],
    ['12', 'EUR', 1200],
    ['0.5', 'EUR', 50],
    ['10.000', 'EUR', 1000],
    ['12.3400', 'EUR', 1234],
    ['1000.0', 'JPY', 1000],
    ['-0.00', 'EUR', 0],
  ])('converts %s %s to %d', (input, currency, expected) => {
    expect(minorFromDecimalString(input, currency, 'x')).toBe(expected);
  });

  it.each([
    ['12.345', 'EUR'],
    ['1.5', 'JPY'],
    ['1.2345', 'KWD'],
    ['abc', 'EUR'],
    ['1,234.50', 'EUR'],
    ['', 'EUR'],
    ['.5', 'EUR'],
    ['9007199254740993', 'JPY'],
    ['90071992547409.93', 'EUR'],
  ])('rejects %s %s', (input, currency) => {
    expect(() => minorFromDecimalString(input, currency, 'x')).toThrow(ProviderResponseError);
  });

  it('rejects non-strings and invalid currency codes', () => {
    expect(() => minorFromDecimalString(12, 'EUR', 'x')).toThrow(ProviderResponseError);
    expect(() => minorFromDecimalString('1', 'XX', 'x')).toThrow(ProviderResponseError);
  });
});

describe('minorFromNumber', () => {
  it('uses the currency exponent', () => {
    expect(minorFromNumber(1000, 'JPY', 'x')).toBe(1000);
    expect(minorFromNumber(12.34, 'EUR', 'x')).toBe(1234);
    expect(minorFromNumber(1.234, 'KWD', 'x')).toBe(1234);
    expect(minorFromNumber(-0.1 - 0.2, 'EUR', 'x')).toBe(-30);
  });

  it('rejects non-finite values and out-of-range magnitudes', () => {
    expect(() => minorFromNumber(NaN, 'EUR', 'x')).toThrow(ProviderResponseError);
    expect(() => minorFromNumber(1e25, 'EUR', 'x')).toThrow(ProviderResponseError);
  });
});
