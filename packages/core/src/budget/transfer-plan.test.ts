import { describe, expect, it } from 'vitest';
import { computeTransferPlan } from './transfer-plan';

describe('computeTransferPlan', () => {
  const plan = (
    lines: Array<[kind: 'income' | 'expense' | 'saving', account: string, n: number]>,
  ) =>
    computeTransferPlan({
      hubAccountId: 'hub',
      lines: lines.map(([kind, accountId, planned]) => ({ kind, accountId, planned })),
    });

  it('income arriving on an account covers that account outflows first', () => {
    const r = plan([
      ['income', 'hub', 100_000],
      ['income', 'x', 60_000],
      ['expense', 'x', 40_000],
      ['saving', 'x', 20_000],
    ]);
    expect(r.perAccount).toEqual([]);
    expect(r.remainingInHub).toBe(100_000);
  });

  it('income partially covering outflows moves only the difference', () => {
    const r = plan([
      ['income', 'hub', 100_000],
      ['income', 'x', 15_000],
      ['expense', 'x', 40_000],
    ]);
    expect(r.perAccount).toEqual([{ accountId: 'x', amount: 25_000, surplus: 0 }]);
    expect(r.remainingInHub).toBe(75_000);
  });

  it('income exceeding outflows reports a surplus and moves nothing back', () => {
    const r = plan([
      ['income', 'hub', 100_000],
      ['income', 'x', 70_000],
      ['expense', 'x', 40_000],
    ]);
    expect(r.perAccount).toEqual([{ accountId: 'x', amount: 0, surplus: 30_000 }]);
    expect(r.remainingInHub).toBe(100_000);
  });

  it('moves expense and saving amounts from the hub to their accounts and keeps the rest', () => {
    const r = computeTransferPlan({
      hubAccountId: 'hub',
      lines: [
        { kind: 'income', accountId: 'hub', planned: 300_000 },
        { kind: 'expense', accountId: 'hub', planned: 100_000 },
        { kind: 'expense', accountId: 'card', planned: 50_000 },
        { kind: 'saving', accountId: 'sav', planned: 40_000 },
        { kind: 'saving', accountId: 'sav', planned: 10_000 },
      ],
    });
    expect(r).toEqual({
      perAccount: [
        { accountId: 'card', amount: 50_000, surplus: 0 },
        { accountId: 'sav', amount: 50_000, surplus: 0 },
      ],
      hubIncome: 300_000,
      hubOutgoing: 100_000,
      remainingInHub: 100_000,
      negative: false,
    });
  });

  it('excludes income arriving outside the hub and counts lines without account against the hub', () => {
    const r = computeTransferPlan({
      hubAccountId: 'hub',
      lines: [
        { kind: 'income', accountId: 'hub', planned: 100_000 },
        { kind: 'income', accountId: 'other', planned: 900_000 },
        { kind: 'income', accountId: null, planned: 20_000 },
        { kind: 'expense', accountId: null, planned: 30_000 },
      ],
    });
    expect(r.remainingInHub).toBe(90_000);
    // 'other' receives its own income and has nothing to pay: all surplus, nothing to move.
    expect(r.perAccount).toEqual([{ accountId: 'other', amount: 0, surplus: 900_000 }]);
  });

  it('flags a negative remainder', () => {
    const r = computeTransferPlan({
      hubAccountId: 'hub',
      lines: [
        { kind: 'income', accountId: 'hub', planned: 10_000 },
        { kind: 'expense', accountId: 'x', planned: 12_500 },
      ],
    });
    expect(r).toMatchObject({ remainingInHub: -2500, negative: true });
  });

  it('a zero remainder is not negative; zero-amount accounts are omitted', () => {
    const r = computeTransferPlan({
      hubAccountId: 'hub',
      lines: [
        { kind: 'income', accountId: 'hub', planned: 100 },
        { kind: 'expense', accountId: 'hub', planned: 100 },
        { kind: 'saving', accountId: 'sav', planned: 0 },
      ],
    });
    expect(r).toEqual({
      perAccount: [],
      hubIncome: 100,
      hubOutgoing: 100,
      remainingInHub: 0,
      negative: false,
    });
  });

  it('reports the hub income and outgoing so that remainingInHub = income - outgoing - moved', () => {
    const r = computeTransferPlan({
      hubAccountId: 'hub',
      lines: [
        { kind: 'income', accountId: 'hub', planned: 300_000 },
        { kind: 'income', accountId: null, planned: 10_000 },
        { kind: 'income', accountId: 'x', planned: 5_000 }, // arrives elsewhere: not hub income
        { kind: 'expense', accountId: 'hub', planned: 100_000 },
        { kind: 'saving', accountId: null, planned: 20_000 },
        { kind: 'expense', accountId: 'x', planned: 45_000 },
      ],
    });
    expect(r.hubIncome).toBe(310_000);
    expect(r.hubOutgoing).toBe(120_000);
    const moved = r.perAccount.reduce((sum, p) => sum + p.amount, 0);
    expect(moved).toBe(40_000);
    expect(r.remainingInHub).toBe(r.hubIncome - r.hubOutgoing - moved);
  });
});
