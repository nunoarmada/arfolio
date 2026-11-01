import { describe, expect, it } from 'vitest';
import {
  mapTrading212Balances,
  mapTrading212Dividend,
  mapTrading212Position,
  mapTrading212Transaction,
  parseTrading212Summary,
} from '../../src/trading212/map.js';
import { ProviderResponseError } from '../../src/types.js';

describe('mapTrading212Transaction', () => {
  const item = (type: string, amount: number) => ({
    reference: 'REF-1',
    type,
    amount,
    currency: 'EUR',
    dateTime: '2026-03-05T23:30:00Z',
  });

  it('signs by type: DEPOSIT positive, WITHDRAW and FEE negative regardless of the given sign', () => {
    expect(mapTrading212Transaction(item('DEPOSIT', 100)).amount).toBe(10000);
    expect(mapTrading212Transaction(item('DEPOSIT', -100)).amount).toBe(10000);
    expect(mapTrading212Transaction(item('WITHDRAW', 25.5)).amount).toBe(-2550);
    expect(mapTrading212Transaction(item('WITHDRAW', -25.5)).amount).toBe(-2550);
    expect(mapTrading212Transaction(item('FEE', 0.12)).amount).toBe(-12);
  });

  it('keeps the given sign for TRANSFER and for unknown types', () => {
    expect(mapTrading212Transaction(item('TRANSFER', 5)).amount).toBe(500);
    expect(mapTrading212Transaction(item('TRANSFER', -5)).amount).toBe(-500);
    expect(mapTrading212Transaction(item('SOMETHING_NEW', -5)).amount).toBe(-500);
  });

  it('produces a booked row with a tx: external id and a UTC booking date', () => {
    expect(mapTrading212Transaction(item('DEPOSIT', 1))).toEqual({
      externalId: 'tx:REF-1',
      bookingDate: '2026-03-05',
      valueDate: '2026-03-05',
      amount: 100,
      currency: 'EUR',
      description: 'DEPOSIT REF-1',
      status: 'booked',
      transactionDate: '2026-03-05',
      occurredAt: '2026-03-05T23:30:00.000Z',
      details: { providerType: 'DEPOSIT' },
    });
  });

  it('normalises offsets to the UTC date', () => {
    const row = mapTrading212Transaction({
      ...item('DEPOSIT', 1),
      dateTime: '2026-03-05T23:30:00-02:00',
    });
    expect(row.bookingDate).toBe('2026-03-06');
  });

  it('keeps the exact instant and the UTC date of the original offset time', () => {
    const row = mapTrading212Transaction({
      ...item('WITHDRAW', 1),
      dateTime: '2026-03-05T23:30:00-02:00',
    });
    expect(row.occurredAt).toBe('2026-03-06T01:30:00.000Z');
    expect(row.transactionDate).toBe('2026-03-06');
    expect(row.details).toEqual({ providerType: 'WITHDRAW' });
  });

  it('treats a timezone-less dateTime as UTC and a date-only value as having no instant', () => {
    const naive = mapTrading212Transaction({
      ...item('WITHDRAW', 1),
      dateTime: '2026-03-05T23:30:00',
    });
    expect(naive.occurredAt).toBe('2026-03-05T23:30:00.000Z');
    expect(naive.transactionDate).toBe('2026-03-05');
    const dateOnly = mapTrading212Transaction({ ...item('WITHDRAW', 1), dateTime: '2026-03-05' });
    expect(dateOnly.transactionDate).toBe('2026-03-05');
    expect(dateOnly.occurredAt).toBeUndefined();
    expect('occurredAt' in dateOnly).toBe(false);
  });

  it('rejects malformed items without echoing values', () => {
    for (const bad of [
      null,
      { ...item('DEPOSIT', 1), reference: undefined },
      { ...item('DEPOSIT', 1), amount: '1' },
      { ...item('DEPOSIT', 1), dateTime: 'nope' },
    ]) {
      expect(() => mapTrading212Transaction(bad)).toThrow(ProviderResponseError);
    }
  });
});

describe('currency exponents', () => {
  it('converts transaction amounts per currency and rejects excess decimals', () => {
    const tx = (amount: number, currency: string) =>
      mapTrading212Transaction({
        reference: 'R',
        type: 'DEPOSIT',
        amount,
        currency,
        dateTime: '2026-03-05T10:00:00Z',
      }).amount;
    expect(tx(1000, 'JPY')).toBe(1000);
    expect(tx(1.234, 'KWD')).toBe(1234);
    expect(tx(12.34, 'EUR')).toBe(1234);
    expect(() => tx(1, 'ZZ')).toThrow(ProviderResponseError);
  });

  it('converts summary values with the account currency exponent', () => {
    const parsed = parseTrading212Summary({
      id: 1,
      currency: 'JPY',
      totalValue: 1500,
      cash: { availableToTrade: 500 },
      investments: { currentValue: 1000 },
    });
    expect(parsed).toMatchObject({ totalValue: 1500, cash: 500, investmentsValue: 1000 });
  });
});

describe('mapTrading212Dividend', () => {
  const dividend = {
    reference: 'DIV-1',
    ticker: 'ABCD_US_EQ',
    type: 'ORDINARY',
    quantity: 10,
    grossAmountPerShare: 0.25,
    amount: 2.13,
    currency: 'EUR',
    paidOn: '2026-02-10T00:00:00Z',
    instrument: { name: 'Example Corp' },
  };

  it('maps a dividend to a positive booked row with the instrument as counterparty', () => {
    expect(mapTrading212Dividend(dividend)).toEqual({
      externalId: 'div:DIV-1',
      bookingDate: '2026-02-10',
      valueDate: '2026-02-10',
      amount: 213,
      currency: 'EUR',
      description: 'Dividend ABCD_US_EQ ORDINARY 10 x 0.25',
      counterparty: 'Example Corp',
      status: 'booked',
      transactionDate: '2026-02-10',
      occurredAt: '2026-02-10T00:00:00.000Z',
      details: {
        providerType: 'ORDINARY',
        instrument: {
          ticker: 'ABCD_US_EQ',
          name: 'Example Corp',
          quantity: '10',
          pricePerShare: '0.25',
        },
      },
    });
  });

  it('gives a date-only paidOn a transaction date but no occurredAt', () => {
    const row = mapTrading212Dividend({ ...dividend, paidOn: '2026-02-10' });
    expect(row.transactionDate).toBe('2026-02-10');
    expect('occurredAt' in row).toBe(false);
  });

  it('tolerates missing optional fields', () => {
    const row = mapTrading212Dividend({
      reference: 'D2',
      amount: 1,
      currency: 'EUR',
      paidOn: '2026-02-10T00:00:00Z',
    });
    expect(row.description).toBe('Dividend');
    expect('counterparty' in row).toBe(false);
    expect(row.details).toBeUndefined();
  });
});

describe('summary and positions', () => {
  const summary = {
    id: 42,
    currency: 'EUR',
    totalValue: 1500.5,
    cash: { availableToTrade: 100.1, inPies: 0.2, reservedForOrders: 0.3 },
    investments: {
      currentValue: 1400,
      totalCost: 1300,
      realizedProfitLoss: 5,
      unrealizedProfitLoss: 100,
    },
  };

  it('parses money into minor units', () => {
    expect(parseTrading212Summary(summary)).toEqual({
      externalUid: '42',
      currency: 'EUR',
      totalValue: 150050,
      cash: 10060,
      cashAvailableToTrade: 10010,
      investmentsValue: 140000,
    });
  });

  it('maps balances: cash is the sum of its parts, plus investments and total', () => {
    const parsed = parseTrading212Summary(summary);
    expect(mapTrading212Balances(parsed, '2026-03-01T00:00:00Z')).toEqual([
      {
        externalUid: '42',
        asOf: '2026-03-01T00:00:00Z',
        amount: 10060,
        currency: 'EUR',
        kind: 'cash',
      },
      {
        externalUid: '42',
        asOf: '2026-03-01T00:00:00Z',
        amount: 140000,
        currency: 'EUR',
        kind: 'investments',
      },
      {
        externalUid: '42',
        asOf: '2026-03-01T00:00:00Z',
        amount: 150050,
        currency: 'EUR',
        kind: 'total',
      },
    ]);
  });

  it('treats null cash components as zero but requires currency and totalValue', () => {
    const parsed = parseTrading212Summary({
      ...summary,
      cash: { availableToTrade: 1, inPies: null },
    });
    expect(parsed.cash).toBe(100);
    expect(() => parseTrading212Summary({ ...summary, currency: undefined })).toThrow(
      ProviderResponseError,
    );
    expect(() => parseTrading212Summary({ ...summary, totalValue: null })).toThrow(
      ProviderResponseError,
    );
  });

  it('maps a position with decimal-string quantities and wallet-impact minor units', () => {
    expect(
      mapTrading212Position({
        instrument: {
          ticker: 'ABCD_US_EQ',
          name: 'Example Corp',
          isin: 'US0000000000',
          currency: 'USD',
        },
        quantity: 1.23456789,
        averagePricePaid: 10,
        currentPrice: 11.5,
        walletImpact: {
          currency: 'EUR',
          totalCost: 100,
          currentValue: 110.25,
          unrealizedProfitLoss: 10.25,
          fxImpact: null,
        },
      }),
    ).toEqual({
      ticker: 'ABCD_US_EQ',
      name: 'Example Corp',
      isin: 'US0000000000',
      instrumentCurrency: 'USD',
      quantity: '1.23456789',
      averagePrice: '10',
      currentPrice: '11.5',
      currency: 'EUR',
      value: 11025,
      cost: 10000,
      unrealizedProfitLoss: 1025,
    });
  });

  it('formats tiny quantities without exponent notation', () => {
    const p = mapTrading212Position({
      instrument: { ticker: 'T', name: 'N', currency: 'USD' },
      quantity: 1e-7,
      averagePricePaid: 1,
      currentPrice: 1,
      walletImpact: { currency: 'EUR', totalCost: 0, currentValue: 0, unrealizedProfitLoss: 0 },
    });
    expect(p.quantity).toBe('0.0000001');
  });
});
