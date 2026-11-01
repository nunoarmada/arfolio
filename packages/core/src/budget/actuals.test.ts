import { describe, expect, it } from 'vitest';
import { computeLineActual, type ActualRow } from './actuals';

const row = (over: Partial<ActualRow> & { amount: number }): ActualRow => ({
  isTransfer: false,
  status: 'booked',
  currency: 'EUR',
  categoryLinked: true,
  accountId: 'acc-1',
  ...over,
});
const opts = { currency: 'EUR', accountId: null };

describe('computeLineActual', () => {
  it('expense actual is minus the signed sum', () => {
    const r = computeLineActual('expense', [row({ amount: -1000 }), row({ amount: -250 })], opts);
    expect(r).toEqual({ actual: 1250, pending: 0, foreignCurrencyRows: 0 });
  });

  it('a refund reduces the expense actual and may take it negative', () => {
    const rows = [row({ amount: -1000 }), row({ amount: 400 })];
    expect(computeLineActual('expense', rows, opts).actual).toBe(600);
    expect(computeLineActual('expense', [row({ amount: 300 })], opts).actual).toBe(-300);
  });

  it('income actual is the signed sum', () => {
    expect(
      computeLineActual('income', [row({ amount: 5000 }), row({ amount: -200 })], opts).actual,
    ).toBe(4800);
  });

  it('transfer rows never count as expense or income', () => {
    const rows = [row({ amount: -5000, isTransfer: true }), row({ amount: -100 })];
    expect(computeLineActual('expense', rows, opts).actual).toBe(100);
    expect(
      computeLineActual('income', [row({ amount: 5000, isTransfer: true })], opts).actual,
    ).toBe(0);
  });

  it('pending rows are reported separately and never added to actual', () => {
    const r = computeLineActual(
      'expense',
      [row({ amount: -1000 }), row({ amount: -300, status: 'pending' })],
      opts,
    );
    expect(r).toMatchObject({ actual: 1000, pending: 300 });
  });

  it('rows in other currencies are counted, not summed', () => {
    const r = computeLineActual(
      'expense',
      [row({ amount: -1000 }), row({ amount: -9999, currency: 'USD' })],
      opts,
    );
    expect(r).toEqual({ actual: 1000, pending: 0, foreignCurrencyRows: 1 });
  });

  it('saving is the net transfer flow on the linked account plus saving categories', () => {
    const rows = [
      // inflow leg into the savings account
      row({ amount: 20_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
      // outflow leg from the hub: not an inflow into the line account
      row({ amount: -20_000, isTransfer: true, accountId: 'hub', categoryLinked: false }),
      // inflow into some other account
      row({ amount: 7000, isTransfer: true, accountId: 'other', categoryLinked: false }),
      // direct contribution booked in a saving category (outflow, signed negative)
      row({ amount: -1500 }),
    ];
    const r = computeLineActual('saving', rows, {
      currency: 'EUR',
      accountId: 'sav',
      source: 'account',
    });
    expect(r.actual).toBe(21_500);
  });

  it('a withdrawal from the linked account reduces saving and may take it negative', () => {
    const rows = [
      row({ amount: 5_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
      row({ amount: -8_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
    ];
    expect(
      computeLineActual('saving', rows, { currency: 'EUR', accountId: 'sav', source: 'account' })
        .actual,
    ).toBe(-3_000);
  });

  it('a saving line on the hub account ignores transfer flow and keeps its categories', () => {
    const rows = [
      row({ amount: 20_000, isTransfer: true, accountId: 'hub', categoryLinked: false }),
      row({ amount: -5_000, isTransfer: true, accountId: 'hub', categoryLinked: false }),
      row({ amount: -1500 }),
    ];
    const r = computeLineActual('saving', rows, {
      currency: 'EUR',
      accountId: 'hub',
      hubAccountId: 'hub',
      source: 'account',
    });
    expect(r.actual).toBe(1500);
  });

  it('saving without a linked account only counts its categories', () => {
    const rows = [
      row({ amount: 20_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
      row({ amount: -1500 }),
    ];
    expect(computeLineActual('saving', rows, { ...opts, source: 'categories' }).actual).toBe(1500);
  });

  it('pending transfer inflows are pending, not actual', () => {
    const r = computeLineActual(
      'saving',
      [
        row({
          amount: 100,
          isTransfer: true,
          accountId: 'sav',
          categoryLinked: false,
          status: 'pending',
        }),
      ],
      { currency: 'EUR', accountId: 'sav', source: 'account' },
    );
    expect(r).toMatchObject({ actual: 0, pending: 100 });
  });

  it('ignores rows that are neither in a linked category nor a relevant transfer inflow', () => {
    const r = computeLineActual('expense', [row({ amount: -100, categoryLinked: false })], opts);
    expect(r).toEqual({ actual: 0, pending: 0, foreignCurrencyRows: 0 });
  });

  describe('saving sources', () => {
    const sav = { currency: 'EUR', accountId: 'sav' };

    it('account_source_counts_all_rows_on_account', () => {
      const rows = [
        row({ amount: 60_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
        row({ amount: -45_000, accountId: 'sav', categoryLinked: false }),
      ];
      expect(computeLineActual('saving', rows, { ...sav, source: 'account' }).actual).toBe(15_000);
    });

    it('account_source_does_not_double_count_category_rows_on_account', () => {
      const rows = [
        row({ amount: 10_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
        row({ amount: -2_000, accountId: 'sav', categoryLinked: true }),
        row({ amount: -500, accountId: 'other', categoryLinked: true }),
      ];
      expect(computeLineActual('saving', rows, { ...sav, source: 'account' }).actual).toBe(
        10_000 - 2_000 + 500,
      );
    });

    it('categories_source_ignores_rows_on_line_account', () => {
      const rows = [
        row({ amount: 10_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
        row({ amount: -2_000, accountId: 'sav', categoryLinked: true }),
        row({ amount: -500, accountId: 'other', categoryLinked: true }),
      ];
      expect(computeLineActual('saving', rows, { ...sav, source: 'categories' }).actual).toBe(500);
    });

    it('omitted_source_defaults_to_categories', () => {
      const rows = [
        row({ amount: 10_000, isTransfer: true, accountId: 'sav', categoryLinked: false }),
        row({ amount: -500, accountId: 'other', categoryLinked: true }),
      ];
      expect(computeLineActual('saving', rows, sav).actual).toBe(500);
    });

    it('account_source_on_hub_behaves_as_categories', () => {
      const rows = [
        row({ amount: 10_000, isTransfer: true, accountId: 'hub', categoryLinked: false }),
        row({ amount: -500, accountId: 'hub', categoryLinked: true }),
      ];
      const hub = { currency: 'EUR', accountId: 'hub', hubAccountId: 'hub' };
      expect(computeLineActual('saving', rows, { ...hub, source: 'account' }).actual).toBe(500);
    });

    it('source_is_ignored_for_expense', () => {
      const rows = [row({ amount: -1000, accountId: 'sav' })];
      expect(computeLineActual('expense', rows, { ...sav, source: 'account' }).actual).toBe(1000);
    });
  });
});
