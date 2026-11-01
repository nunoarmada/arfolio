import { describe, expect, it } from 'vitest';
import { availableBalance, shownBalance } from './available';

type Acc = {
  type: string;
  currency: string;
  includeInNetWorth: boolean;
  balance: number;
  cash: number;
  invested: number;
};

const acc = (over: Partial<Acc> & { type: string }): Acc => ({
  currency: 'EUR',
  includeInNetWorth: true,
  balance: 0,
  cash: 0,
  invested: 0,
  ...over,
});

describe('shownBalance', () => {
  it('is the money not invested', () => {
    expect(
      shownBalance(acc({ type: 'investment', balance: 1500, cash: 500, invested: 1000 })),
    ).toBe(500);
    expect(shownBalance(acc({ type: 'checking', balance: 300, cash: 300 }))).toBe(300);
  });

  it('falls back to the balance when the parts are missing', () => {
    expect(shownBalance({ type: 'checking', balance: 42 })).toBe(42);
  });

  it('shows what a card owes, as a negative amount', () => {
    expect(shownBalance({ type: 'card', balance: 300, cash: 300, owed: 1200 })).toBe(-1200);
    expect(shownBalance({ type: 'card', balance: 0, owed: null })).toBe(-0);
  });
});

describe('availableBalance', () => {
  it('adds the cash of bank and investment accounts, never cards, loans or excluded ones', () => {
    const accounts = [
      acc({ type: 'checking', balance: 300, cash: 300 }),
      acc({ type: 'investment', balance: 1500, cash: 500, invested: 1000 }),
      acc({ type: 'card', balance: -80, cash: -80 }),
      acc({ type: 'loan', balance: -9000, cash: -9000 }),
      acc({ type: 'savings', balance: 50, cash: 50, includeInNetWorth: false }),
    ];
    expect(availableBalance(accounts, 'EUR')).toEqual({ available: 800, otherCurrency: 0 });
  });

  it('counts accounts in another currency, never adds them, and skips investment accounts with no cash', () => {
    const accounts = [
      acc({ type: 'checking', balance: 10, cash: 10, currency: 'USD' }),
      acc({ type: 'investment', balance: 900, cash: 0, invested: 900, currency: 'USD' }),
    ];
    expect(availableBalance(accounts, 'EUR')).toEqual({ available: 0, otherCurrency: 1 });
  });
});
