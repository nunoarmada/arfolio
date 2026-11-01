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
});
