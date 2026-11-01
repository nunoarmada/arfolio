import type { ServiceCtx } from '@arfolio/services';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listHoldings = vi.fn();
// vi.mock is hoisted above this module's declarations, so the class must be hoisted too.
const { NotFoundError } = vi.hoisted(() => ({
  NotFoundError: class NotFoundError extends Error {
    override name = 'NotFoundError';
  },
}));
vi.mock('@arfolio/services', () => ({
  listHoldings: (...args: unknown[]) => listHoldings(...args),
  NotFoundError,
}));

import { loadHoldings } from './holdings-data';

const ctx = {} as ServiceCtx;

describe('loadHoldings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the holdings', async () => {
    const holdings = { asOf: null, currency: 'EUR', total: '0.00', items: [] };
    listHoldings.mockResolvedValueOnce(holdings);
    await expect(loadHoldings(ctx, 'a')).resolves.toBe(holdings);
  });

  it('fails alone: null, and only the error type is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listHoldings.mockRejectedValueOnce(new TypeError('secret detail'));
    await expect(loadHoldings(ctx, 'a')).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith('holdings failed: TypeError');
  });

  it('a missing account is null without an error log: the page answers 404 itself', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listHoldings.mockRejectedValueOnce(new NotFoundError('Account'));
    await expect(loadHoldings(ctx, 'a')).resolves.toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('fails alone when an amount is beyond what can be shown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listHoldings.mockResolvedValueOnce({
      asOf: '2026-10-01',
      currency: 'EUR',
      total: '100000000000000000.00',
      items: [],
    });
    await expect(loadHoldings(ctx, 'a')).resolves.toBeNull();
    const item = {
      ticker: 'X',
      name: 'X',
      isin: null,
      currency: 'EUR',
      quantity: '1',
      value: '10.00',
      cost: '100000000000000000.00',
      profit: null,
      profitBps: null,
      weightBps: null,
    };
    listHoldings.mockResolvedValueOnce({
      asOf: '2026-10-01',
      currency: 'EUR',
      total: '10.00',
      items: [item],
    });
    await expect(loadHoldings(ctx, 'a')).resolves.toBeNull();
  });
});
