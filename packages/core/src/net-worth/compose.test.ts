import { describe, expect, it } from 'vitest';
import { composeNetWorth } from './compose';

describe('composeNetWorth', () => {
  it('sums household-currency items; liabilities are positive and subtracted', () => {
    const r = composeNetWorth(
      [
        { side: 'asset', kind: 'real_estate', amount: 30_000_000, currency: 'EUR' },
        { side: 'asset', kind: 'cash', amount: 500_000, currency: 'EUR' },
        { side: 'asset', kind: 'cash', amount: 250_000, currency: 'EUR' },
        { side: 'liability', kind: 'mortgage', amount: 20_000_000, currency: 'EUR' },
      ],
      'EUR',
    );
    expect(r.assets).toBe(30_750_000);
    expect(r.liabilities).toBe(20_000_000);
    expect(r.net).toBe(10_750_000);
    expect(r.byKind).toEqual({
      'asset:real_estate': 30_000_000,
      'asset:cash': 750_000,
      'liability:mortgage': 20_000_000,
    });
    expect(r.foreign).toEqual([]);
  });

  it('excludes foreign-currency items from totals and lists them', () => {
    const usd = { side: 'asset' as const, kind: 'investment', amount: 99_999, currency: 'USD' };
    const r = composeNetWorth(
      [{ side: 'asset', kind: 'cash', amount: 1000, currency: 'EUR' }, usd],
      'EUR',
    );
    expect(r.assets).toBe(1000);
    expect(r.net).toBe(1000);
    expect(r.byKind).toEqual({ 'asset:cash': 1000 });
    expect(r.foreign).toEqual([usd]);
  });

  it('is zero for no items and can be negative', () => {
    expect(composeNetWorth([], 'EUR')).toEqual({
      assets: 0,
      liabilities: 0,
      net: 0,
      byKind: {},
      foreign: [],
    });
    expect(
      composeNetWorth([{ side: 'liability', kind: 'card', amount: 300, currency: 'EUR' }], 'EUR')
        .net,
    ).toBe(-300);
  });
});
