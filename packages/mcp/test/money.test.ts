import { describe, expect, it } from 'vitest';
import { formatMoney, InvalidAmountError, parseMoneyInput } from '../src/money.js';

describe('parseMoneyInput', () => {
  it.each([
    ['12.34', 'EUR', 1234],
    ['-12.34', 'EUR', -1234],
    ['12', 'EUR', 1200],
    ['12.5', 'EUR', 1250],
    ['0.01', 'EUR', 1],
    ['0', 'EUR', 0],
    ['1000', 'JPY', 1000],
    ['1.234', 'KWD', 1234],
  ])('accepts %s %s as %i minor units', (text, currency, minor) => {
    expect(parseMoneyInput(text, currency)).toBe(minor);
  });

  it.each([
    ['12,34', 'EUR'],
    ['1e3', 'EUR'],
    ['0.001', 'EUR'],
    ['12.345', 'EUR'],
    ['1.5', 'JPY'],
    ['1.2345', 'KWD'],
    ['+12.34', 'EUR'],
    ['1 234.00', 'EUR'],
    ['1,234.00', 'EUR'],
    ['€12.34', 'EUR'],
    ['12.34 EUR', 'EUR'],
    ['(12.34)', 'EUR'],
    ['12.', 'EUR'],
    ['.5', 'EUR'],
    ['--1', 'EUR'],
    ['', 'EUR'],
    [' 12.34', 'EUR'],
    ['0x10', 'EUR'],
    ['Infinity', 'EUR'],
    ['NaN', 'EUR'],
  ])('rejects %j (%s) instead of rounding or guessing', (text, currency) => {
    expect(() => parseMoneyInput(text, currency)).toThrow(InvalidAmountError);
  });

  it('rejects a value beyond the safe integer range', () => {
    expect(() => parseMoneyInput('90071992547409.93', 'EUR')).toThrow(InvalidAmountError);
    expect(parseMoneyInput('90071992547409.91', 'EUR')).toBe(9007199254740991);
  });

  it('rejects a currency code that is not ISO 4217 shaped', () => {
    expect(() => parseMoneyInput('1', 'euro')).toThrow(InvalidAmountError);
  });
});

describe('formatMoney', () => {
  it('formats minor units as decimal string, minor string and currency', () => {
    expect(formatMoney(-1234, 'EUR')).toEqual({
      amount: '-12.34',
      amount_minor: '-1234',
      currency: 'EUR',
    });
    expect(formatMoney(5, 'EUR').amount).toBe('0.05');
    expect(formatMoney(-5, 'EUR').amount).toBe('-0.05');
    expect(formatMoney(0, 'EUR').amount).toBe('0.00');
    expect(formatMoney(1000, 'JPY').amount).toBe('1000');
    expect(formatMoney(1234, 'KWD').amount).toBe('1.234');
  });

  it('keeps amounts beyond the double-safe range exact (bigint in, string out)', () => {
    expect(formatMoney(12345678901234567890n, 'EUR')).toEqual({
      amount: '123456789012345678.90',
      amount_minor: '12345678901234567890',
      currency: 'EUR',
    });
  });

  it('round-trips with parseMoneyInput', () => {
    for (const minor of [0, 1, -1, 99, 100, -123456, 9007199254740991]) {
      expect(parseMoneyInput(formatMoney(minor, 'EUR').amount, 'EUR')).toBe(minor);
    }
  });
});
