import { describe, expect, it } from 'vitest';
import {
  isIngestibleEnableBankingStatus,
  mapEnableBankingTransaction,
} from '../../src/enablebanking/map.js';
import { ProviderResponseError } from '../../src/types.js';

function without<T extends Record<string, unknown>>(
  obj: T,
  ...keys: string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

const base = {
  entry_reference: 'ref-1',
  transaction_id: 'tid-1',
  status: 'BOOK',
  credit_debit_indicator: 'DBIT',
  transaction_amount: { amount: '12.34', currency: 'EUR' },
  booking_date: '2026-03-05',
  value_date: '2026-03-06',
  creditor: { name: 'Corner Shop' },
  debtor: { name: 'Account Holder' },
  remittance_information: ['Groceries'],
};

describe('mapEnableBankingTransaction', () => {
  describe('transaction details', () => {
    const full = {
      entry_reference: 'entry-9',
      transaction_id: 'tid-9',
      merchant_category_code: '5411',
      status: 'BOOK',
      credit_debit_indicator: 'DBIT',
      transaction_amount: { amount: '12.34', currency: 'EUR' },
      booking_date: '2026-03-05',
      value_date: '2026-03-06',
      transaction_date: '2026-03-04',
      creditor: { name: 'Corner Shop' },
      creditor_account: {
        iban: 'PT50000201231234567890154',
        other: { identification: 'ACC-77', scheme_name: 'BBAN' },
      },
      creditor_agent: { bic_fi: 'TESTPTPL', name: 'Bank' },
      creditor_account_additional_identification: [{ identification: 'EXTRA-1' }],
      debtor: { name: 'Account Holder' },
      debtor_account: { iban: 'PT50999999999999999999999' },
      debtor_agent: { bic_fi: 'TESTPTPL' },
      bank_transaction_code: { description: 'Card payment', code: 'PMNT', sub_code: 'CCRD' },
      balance_after_transaction: { amount: '1234.56', currency: 'EUR' },
      reference_number: 'REF-123',
      remittance_information: ['Groceries', 'Card 1234'],
      exchange_rate: {
        unit_currency: 'USD',
        exchange_rate: '1.0875',
        rate_type: 'SPOT',
        instructed_amount: { amount: '13.42', currency: 'USD' },
      },
      note: 'weekly shop',
    };

    it('maps every provider field it knows about', () => {
      const row = mapEnableBankingTransaction(full, 'EUR');
      expect(row.transactionDate).toBe('2026-03-04');
      expect(row.mcc).toBe('5411');
      expect(row.occurredAt).toBeUndefined();
      expect(row.details).toEqual({
        remittance: ['Groceries', 'Card 1234'],
        note: 'weekly shop',
        reference: 'REF-123',
        entryReference: 'entry-9',
        bankCode: { code: 'PMNT', subCode: 'CCRD', description: 'Card payment' },
        counterpartyAccount: {
          iban: 'PT50000201231234567890154',
          other: 'ACC-77',
          bic: 'TESTPTPL',
        },
        originalAmount: { amount: -1342, currency: 'USD' },
        exchangeRate: '1.0875',
        balanceAfter: { amount: 123456, currency: 'EUR' },
      });
    });

    it('uses the debtor side for a credit', () => {
      const row = mapEnableBankingTransaction({ ...full, credit_debit_indicator: 'CRDT' }, 'EUR');
      expect(row.details?.counterpartyAccount).toEqual({
        iban: 'PT50999999999999999999999',
        bic: 'TESTPTPL',
      });
      expect(row.details?.originalAmount?.amount).toBe(1342);
    });

    it('falls back to a simple additional identification when there is no other id', () => {
      const row = mapEnableBankingTransaction(
        { ...full, creditor_account: { iban: 'PT50000201231234567890154' } },
        'EUR',
      );
      expect(row.details?.counterpartyAccount?.other).toBe('EXTRA-1');
    });

    it('records the original amount only when its currency differs', () => {
      const same = {
        ...full,
        exchange_rate: {
          ...full.exchange_rate,
          instructed_amount: { amount: '12.34', currency: 'EUR' },
        },
      };
      const row = mapEnableBankingTransaction(same, 'EUR');
      expect(row.details?.originalAmount).toBeUndefined();
      expect(row.details?.exchangeRate).toBeUndefined();
    });

    it('keeps the sign of a negative balance after the transaction', () => {
      const row = mapEnableBankingTransaction(
        { ...full, balance_after_transaction: { amount: '-50.00', currency: 'EUR' } },
        'EUR',
      );
      expect(row.details?.balanceAfter).toEqual({ amount: -5000, currency: 'EUR' });
    });

    it('drops an invalid mcc', () => {
      for (const bad of ['541', '54111', 'abcd', 5411, null]) {
        expect(
          mapEnableBankingTransaction({ ...full, merchant_category_code: bad }, 'EUR').mcc,
        ).toBeUndefined();
      }
    });

    it('drops malformed sub-objects without throwing', () => {
      const row = mapEnableBankingTransaction(
        {
          ...base,
          transaction_date: 'garbage',
          bank_transaction_code: 'x',
          creditor_account: 7,
          creditor_agent: [],
          balance_after_transaction: { amount: 'abc', currency: 'EUR' },
          exchange_rate: { exchange_rate: 5, instructed_amount: 'x' },
          remittance_information: 'single line',
          reference_number: { a: 1 },
        },
        'EUR',
      );
      expect(row.transactionDate).toBeUndefined();
      expect(row.details).toEqual({ remittance: ['single line'], entryReference: 'ref-1' });
    });

    it('omits details entirely when there is nothing beyond the typed fields', () => {
      const row = mapEnableBankingTransaction(
        { ...base, remittance_information: [], entry_reference: undefined },
        'EUR',
      );
      expect(row.details).toBeUndefined();
      expect('details' in row).toBe(false);
    });
  });

  it('maps a booked debit: negative amount, creditor as counterparty, transaction_id first', () => {
    expect(mapEnableBankingTransaction(base, 'EUR')).toEqual({
      externalId: 'tid-1',
      bookingDate: '2026-03-05',
      valueDate: '2026-03-06',
      amount: -1234,
      currency: 'EUR',
      description: 'Groceries',
      counterparty: 'Corner Shop',
      status: 'booked',
      details: { remittance: ['Groceries'], entryReference: 'ref-1' },
    });
  });

  it('maps a credit: positive amount, debtor as counterparty', () => {
    const row = mapEnableBankingTransaction({ ...base, credit_debit_indicator: 'CRDT' }, 'EUR');
    expect(row.amount).toBe(1234);
    expect(row.counterparty).toBe('Account Holder');
  });

  it('maps PDNG to pending and HOLD/SCHD/OTHR to pending too', () => {
    for (const status of ['PDNG', 'HOLD', 'SCHD', 'OTHR']) {
      expect(mapEnableBankingTransaction({ ...base, status }, 'EUR').status).toBe('pending');
    }
  });

  it('rejects a missing or empty status', () => {
    for (const status of [undefined, null, '', '  ']) {
      expect(() => mapEnableBankingTransaction({ ...base, status }, 'EUR')).toThrow(
        ProviderResponseError,
      );
    }
  });

  it('converts amounts with the currency exponent and rejects excess decimals', () => {
    const amount = (a: string, currency: string) =>
      mapEnableBankingTransaction(
        { ...base, credit_debit_indicator: 'CRDT', transaction_amount: { amount: a, currency } },
        'EUR',
      ).amount;
    expect(amount('1000', 'JPY')).toBe(1000);
    expect(amount('1.234', 'KWD')).toBe(1234);
    expect(amount('10.000', 'EUR')).toBe(1000);
    expect(() => amount('12.345', 'EUR')).toThrow(ProviderResponseError);
    expect(() => amount('1.5', 'JPY')).toThrow(ProviderResponseError);
    expect(() => amount('1', 'ZZ')).toThrow(ProviderResponseError);
  });

  it('rejects cancelled and rejected transactions', () => {
    for (const status of ['CNCL', 'RJCT']) {
      expect(() => mapEnableBankingTransaction({ ...base, status }, 'EUR')).toThrow(
        ProviderResponseError,
      );
    }
  });

  it('compares the trimmed status, so padded values are classified like plain ones', () => {
    expect(mapEnableBankingTransaction({ ...base, status: ' BOOK ' }, 'EUR').status).toBe('booked');
    expect(mapEnableBankingTransaction({ ...base, status: ' HOLD' }, 'EUR').status).toBe('pending');
    expect(isIngestibleEnableBankingStatus(' CNCL ')).toBe(false);
    expect(isIngestibleEnableBankingStatus('RJCT\n')).toBe(false);
    expect(isIngestibleEnableBankingStatus(' BOOK ')).toBe(true);
    expect(() => mapEnableBankingTransaction({ ...base, status: ' CNCL ' }, 'EUR')).toThrow(
      ProviderResponseError,
    );
  });

  it('falls back to entry_reference, and never invents an id when both are missing', () => {
    const noTid = without(base, 'transaction_id');
    expect(mapEnableBankingTransaction(noTid, 'EUR').externalId).toBe('ref-1');
    const noIds = without(noTid, 'entry_reference');
    const row = mapEnableBankingTransaction(noIds, 'EUR');
    expect(row.externalId).toBeUndefined();
    expect('externalId' in row).toBe(false);
    const nulls = mapEnableBankingTransaction(
      { ...base, transaction_id: null, entry_reference: null },
      'EUR',
    );
    expect(nulls.externalId).toBeUndefined();
  });

  it('joins multi-line remittance information with spaces', () => {
    const row = mapEnableBankingTransaction(
      { ...base, remittance_information: ['Line one', '  Line two ', ''] },
      'EUR',
    );
    expect(row.description).toBe('Line one Line two');
  });

  it('falls back through note, bank transaction code and reference number for the description', () => {
    const bare = { ...base, remittance_information: undefined };
    expect(mapEnableBankingTransaction({ ...bare, note: 'A note' }, 'EUR').description).toBe(
      'A note',
    );
    expect(
      mapEnableBankingTransaction(
        { ...bare, bank_transaction_code: { description: 'Card' } },
        'EUR',
      ).description,
    ).toBe('Card');
    expect(
      mapEnableBankingTransaction({ ...bare, reference_number: 'R-9' }, 'EUR').description,
    ).toBe('R-9');
    expect(mapEnableBankingTransaction(bare, 'EUR').description).toBe('Corner Shop');
  });

  it('uses the transaction currency for foreign-currency rows', () => {
    const row = mapEnableBankingTransaction(
      { ...base, transaction_amount: { amount: '1000.50', currency: 'USD' } },
      'EUR',
    );
    expect(row.currency).toBe('USD');
    expect(row.amount).toBe(-100050);
  });

  it('falls back to the account currency when the transaction has none', () => {
    const row = mapEnableBankingTransaction(
      { ...base, transaction_amount: { amount: '5.00' } },
      'GBP',
    );
    expect(row.currency).toBe('GBP');
  });

  it('uses value_date or transaction_date when booking_date is missing (pending rows)', () => {
    const noBooking = without(base, 'booking_date');
    expect(mapEnableBankingTransaction(noBooking, 'EUR').bookingDate).toBe('2026-03-06');
    const onlyTxDate = without(noBooking, 'value_date');
    const row = mapEnableBankingTransaction(
      { ...onlyTxDate, transaction_date: '2026-03-04' },
      'EUR',
    );
    expect(row.bookingDate).toBe('2026-03-04');
    expect('valueDate' in row).toBe(false);
  });

  it('throws ProviderResponseError for malformed transactions', () => {
    for (const bad of [
      null,
      'x',
      { ...base, credit_debit_indicator: 'XXXX' },
      { ...base, transaction_amount: { amount: 'abc', currency: 'EUR' } },
      { ...base, transaction_amount: undefined },
      { ...base, booking_date: undefined, value_date: undefined },
    ]) {
      expect(() => mapEnableBankingTransaction(bad, 'EUR')).toThrow(ProviderResponseError);
    }
  });

  it('does not put raw payload values in error messages', () => {
    try {
      mapEnableBankingTransaction(
        { ...base, transaction_amount: { amount: 'SECRET-AMOUNT', currency: 'EUR' } },
        'EUR',
      );
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-AMOUNT');
    }
  });
});
