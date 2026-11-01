import { describe, expect, it } from 'vitest';
import {
  decimalToMinor,
  formatAsOf,
  formatBps,
  formatQuantity,
  formatQuantityFor,
  gainSign,
  isStale,
  signedAmount,
} from './holdings-format';

describe('holdings format', () => {
  it('reads exact decimals as minor units', () => {
    expect(decimalToMinor('1234.56', 'EUR')).toBe(123456);
    expect(decimalToMinor('-35.5', 'EUR')).toBe(-3550);
    expect(decimalToMinor('12', 'EUR')).toBe(1200);
    expect(decimalToMinor('0.00', 'EUR')).toBe(0);
    expect(decimalToMinor('-0.00', 'EUR')).toBe(0);
    expect(decimalToMinor('1500', 'JPY')).toBe(1500);
  });

  it('writes percentages with one decimal and a real minus', () => {
    expect(formatBps(4120, 'pt-PT')).toMatch(/^41,2\s?%$/);
    expect(formatBps(820, 'pt-PT', true)).toMatch(/^\+8,2\s?%$/);
    expect(formatBps(-820, 'pt-PT', true)).toMatch(/^−8,2\s?%$/);
    expect(formatBps(0, 'pt-PT', true)).toMatch(/^0,0\s?%$/);
  });

  it('trims the quantity', () => {
    expect(formatQuantity('12.5', 'pt-PT')).toBe('12,5');
    expect(formatQuantity('2.5000000000', 'en')).toBe('2.5');
    expect(formatQuantity('0.1234567', 'en')).toBe('0.123457');
  });

  it('signs gains', () => {
    expect(gainSign(5)).toBe('gain');
    expect(gainSign(-5)).toBe('loss');
    expect(gainSign(0)).toBe('flat');
    expect(signedAmount(5, '5,00 €')).toBe('+5,00 €');
    expect(signedAmount(-5, '5,00 €')).toBe('−5,00 €');
    expect(signedAmount(0, '0,00 €')).toBe('0,00 €');
  });

  it('is stale after 3 days', () => {
    expect(isStale('2026-10-24', '2026-10-27')).toBe(false);
    expect(isStale('2026-10-23', '2026-10-27')).toBe(true);
  });

  it('shows the year only outside the current one', () => {
    expect(formatAsOf('2026-10-14', '2026-10-27', 'pt-PT')).not.toContain('2026');
    expect(formatAsOf('2026-10-14', '2026-10-27', 'pt-PT')).toContain('14');
    expect(formatAsOf('2025-10-14', '2026-10-27', 'pt-PT')).toContain('2025');
  });
});

describe('formatQuantityFor', () => {
  it('formats normally when amounts are visible', () => {
    expect(formatQuantityFor(false)('12.5', 'pt-PT')).toBe('12,5');
  });

  it('masks the quantity in privacy mode, since quantity × price is the position value', () => {
    expect(formatQuantityFor(true)('12.5', 'pt-PT')).toBe('••••');
  });
});
