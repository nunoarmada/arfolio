import { formatMoney } from '@arfolio/core';
import { describe, expect, it } from 'vitest';
import { formatMoneyFor, maskMoney, MONEY_MASK } from './money-privacy';

const spaces = (s: string) => s.replace(/\s/g, ' ');

describe('maskMoney', () => {
  it('keeps the pt-PT symbol after the mask', () => {
    expect(spaces(maskMoney('EUR', 'pt-PT'))).toBe('•••• €');
  });

  it('keeps the symbol first where the locale puts it first', () => {
    expect(maskMoney('EUR', 'en')).toBe('€••••');
  });

  it('works for a currency without minor units', () => {
    expect(maskMoney('JPY', 'en')).toBe('¥••••');
  });

  it('never contains a digit', () => {
    for (const [c, l] of [
      ['EUR', 'pt-PT'],
      ['EUR', 'en'],
      ['JPY', 'en'],
      ['KWD', 'pt-PT'],
    ]) {
      expect(maskMoney(c!, l!)).not.toMatch(/\d/);
      expect(maskMoney(c!, l!)).toContain(MONEY_MASK);
    }
  });
});

describe('formatMoneyFor', () => {
  it('is the plain formatter when amounts are visible', () => {
    expect(formatMoneyFor(false)(123456, 'EUR', 'pt-PT')).toBe(formatMoney(123456, 'EUR', 'pt-PT'));
  });

  it('masks any amount, sign and compact form when hidden', () => {
    expect(formatMoneyFor(true)(-123456, 'EUR', 'pt-PT', { compact: true })).toBe(
      maskMoney('EUR', 'pt-PT'),
    );
  });
});
