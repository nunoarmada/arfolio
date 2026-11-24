import { describe, expect, it } from 'vitest';
import { AmountParseError, parseAmount } from './amount';

describe('parseAmount', () => {
  it.each([
    ['1.234,56', 123456],
    ['-1 234,56 €', -123456],
    ['(12,00)', -1200],
    ['1,234.56', 123456],
    ['12', 1200],
    ['0,5', 50],
    ['€ 3.00-', -300],
    ['+7,25', 725],
    ['EUR 1 000,00', 100000],
    ["1'234.50", 123450],
    ['1.234', 123400],
    ['1,234,567.89', 123456789],
    ['-0,01', -1],
  ])('parses %j as %i minor units', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it('honours an explicit decimal separator', () => {
    expect(parseAmount('1.5', { decimal: '.' })).toBe(150);
    expect(parseAmount('1.234', { decimal: ',' })).toBe(123400);
  });

  it.each(['1.2.3', '1,23.456', '1234,567.89'])('rejects malformed grouping %j', (input) => {
    expect(() => parseAmount(input)).toThrow(AmountParseError);
  });

  it.each(['abc', '', '  ', '1,2,3x', '--5', '12,345', '€', '1.234'])(
    'throws AmountParseError on %j',
    (input) => {
      expect(() =>
        parseAmount(
          input,
          input === '12,345' ? { decimal: ',' } : input === '1.234' ? { decimal: '.' } : undefined,
        ),
      ).toThrow(AmountParseError);
    },
  );

  describe('with the currency minor digits', () => {
    it.each([
      ['1.234', 0, 1234],
      ['1,234', 0, 1234],
      ['¥ 1 234', 0, 1234],
      ['-12', 0, -12],
      ['1234.00', 0, 1234],
      ['1.234,56', 2, 123456],
      ['12', 2, 1200],
      ['1.234', 3, 1234],
      ['1,234', 3, 1234],
      ['1,234.567', 3, 1234567],
      ['1.234,5', 3, 1234500],
      ['-0,005', 3, -5],
      ['12', 3, 12000],
      ['KWD 1.234,567', 3, 1234567],
    ])('parses %j with %i digits as %i minor units', (input, minorDigits, expected) => {
      expect(parseAmount(input, { minorDigits })).toBe(expected);
    });

    it('defaults to two digits', () => {
      expect(parseAmount('1.234')).toBe(parseAmount('1.234', { minorDigits: 2 }));
    });

    it('honours an explicit decimal separator', () => {
      expect(parseAmount('1.234', { decimal: ',', minorDigits: 3 })).toBe(1234000);
      expect(parseAmount('1,234', { decimal: '.', minorDigits: 0 })).toBe(1234);
      expect(parseAmount('12.5', { decimal: '.', minorDigits: 3 })).toBe(12500);
    });

    it.each([
      ['12.50', 0, '.'],
      ['1.2345', 3, '.'],
      ['12,345', 2, ','],
    ] as const)('rejects %j: more decimals than %i', (input, minorDigits, decimal) => {
      expect(() => parseAmount(input, { minorDigits, decimal })).toThrow(AmountParseError);
    });

    it.each([-1, 1.5, 5])('rejects %j minor digits', (minorDigits) => {
      expect(() => parseAmount('1', { minorDigits })).toThrow(RangeError);
    });
  });
});
