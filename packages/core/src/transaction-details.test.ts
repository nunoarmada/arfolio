import { describe, expect, it } from 'vitest';
import {
  TRANSACTION_DETAILS_MAX_BYTES,
  isValidMcc,
  parseTransactionDetails,
} from './transaction-details';

describe('parseTransactionDetails', () => {
  it('keeps every valid field', () => {
    const full = {
      remittance: ['Line one', 'Line two'],
      note: 'a note',
      reference: 'REF-1',
      entryReference: 'E-1',
      bankCode: { code: 'PMNT', subCode: 'CCRD', description: 'Card payment' },
      counterpartyAccount: { iban: 'PT50000201231234567890154', other: 'ID-9', bic: 'TESTPTPL' },
      originalAmount: { amount: -1500, currency: 'USD' },
      exchangeRate: '1.0875',
      balanceAfter: { amount: 123456, currency: 'EUR' },
      providerType: 'WITHDRAW',
      merchantCategory: 'Groceries',
      instrument: {
        ticker: 'ABCD',
        name: 'Example',
        isin: 'US0000000000',
        quantity: '10',
        pricePerShare: '0.25',
      },
      location: { city: 'Lisbon', country: 'PT' },
    };
    expect(parseTransactionDetails(full)).toEqual(full);
  });

  it('returns undefined for non-objects and for objects with nothing usable', () => {
    for (const raw of [undefined, null, 'x', 5, [], {}, { unknown: 1 }, { note: '  ' }]) {
      expect(parseTransactionDetails(raw)).toBeUndefined();
    }
  });

  it('drops unknown keys and invalid sub-fields without throwing', () => {
    expect(
      parseTransactionDetails({
        note: 'ok',
        evil: 'x',
        reference: 42,
        bankCode: 'nope',
        counterpartyAccount: { iban: 7, bic: 'TESTPTPL' },
        originalAmount: { amount: 1.5, currency: 'USD' },
        balanceAfter: { amount: 10, currency: 'euro' },
        location: { city: 'Porto', country: 'Portugal' },
      }),
    ).toEqual({
      note: 'ok',
      counterpartyAccount: { bic: 'TESTPTPL' },
      location: { city: 'Porto' },
    });
  });

  it('caps remittance at 10 lines of 500 characters and skips blank lines', () => {
    const lines = [' ', ...Array.from({ length: 12 }, (_, i) => `L${i}`.padEnd(600, 'x'))];
    const out = parseTransactionDetails({ remittance: lines });
    expect(out?.remittance).toHaveLength(10);
    expect(out?.remittance?.every((l) => l.length === 500)).toBe(true);
  });

  it('strips NUL characters, which Postgres jsonb rejects', () => {
    const out = parseTransactionDetails({
      note: 'a\u0000b',
      remittance: ['x\u0000y', '\u0000'],
      bankCode: { code: '\u0000' },
    });
    expect(out).toEqual({ note: 'ab', remittance: ['xy'] });
    expect(JSON.stringify(out)).not.toContain('\\u0000');
  });

  it('measures the size cap in bytes, not characters', () => {
    const out = parseTransactionDetails({
      remittance: Array.from({ length: 10 }, () => 'é'.repeat(300)),
      reference: 'REF',
    });
    expect(out?.reference).toBe('REF');
    expect(out?.remittance).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(
      TRANSACTION_DETAILS_MAX_BYTES,
    );
  });

  it('stays within the size bound by dropping the free-text fields first', () => {
    const lines = Array.from({ length: 10 }, () => 'y'.repeat(500));
    const out = parseTransactionDetails({
      remittance: lines,
      note: 'n'.repeat(1_000),
      reference: 'REF',
    });
    expect(out).toBeDefined();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TRANSACTION_DETAILS_MAX_BYTES);
    expect(out?.reference).toBe('REF');
  });
});

describe('isValidMcc', () => {
  it('accepts exactly four digits', () => {
    expect(isValidMcc('5411')).toBe(true);
    for (const bad of ['541', '54111', 'abcd', '54 1', '', null, 5411]) {
      expect(isValidMcc(bad)).toBe(false);
    }
  });
});
