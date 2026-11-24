import { describe, expect, it } from 'vitest';
import { InvalidAmountError, parseMoneyInput } from './money-input';

describe('parseMoneyInput', () => {
  it('parses plain decimals into minor units for the currency', () => {
    expect(parseMoneyInput('12.34', 'EUR')).toBe(1234);
    expect(parseMoneyInput('1000', 'JPY')).toBe(1000);
  });

  it('refuses anything it would have to guess', () => {
    expect(() => parseMoneyInput('12,34', 'EUR')).toThrow(InvalidAmountError);
    expect(() => parseMoneyInput('0.001', 'EUR')).toThrow(InvalidAmountError);
  });
});
