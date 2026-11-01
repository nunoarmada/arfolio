import { describe, expect, it } from 'vitest';
import {
  buildDetails,
  compactIban,
  currencySymbol,
  decimalToMinor,
  groupIban,
  ibanEnding,
  locationParts,
  maskIban,
  purchaseDay,
  formatRate,
  type DetailTx,
} from './transaction-details-view';

const IBAN = 'PT50 0002 0123 1234 5678 9015 4';

const tx: DetailTx = {
  bookingDate: '2026-10-14',
  valueDate: null,
  transactionDate: null,
  occurredAt: null,
  amount: -1250,
  currency: 'EUR',
  rawDescription: 'COMPRA 1234 CONTINENTE',
  mcc: null,
  source: 'connector',
  merchant: null,
  location: null,
};
const build = (over: Partial<DetailTx> = {}, details: Parameters<typeof buildDetails>[1] = null) =>
  buildDetails({ ...tx, ...over }, details, 'pt-PT', 'Europe/Lisbon');
const ids = (fields: { id: string }[]) => fields.map((f) => f.id);

describe('IBAN helpers', () => {
  it('masks the middle and keeps the country, check digits and ending', () => {
    expect(maskIban(IBAN)).toBe('PT50 •••• … 9015 4');
    expect(maskIban(IBAN)).not.toContain('0002');
  });
  it('masks a value that is not IBAN-shaped down to its last four', () => {
    expect(maskIban('123456789')).toBe('•••• 6789');
    expect(maskIban('ab 12')).toBe('•••• AB12');
    expect(ibanEnding('123456789')).toBe('6789');
  });
  it('groups by four and copies without spaces', () => {
    expect(groupIban('pt50000201231234567890154')).toBe(IBAN);
    expect(compactIban(IBAN)).toBe('PT50000201231234567890154');
    expect(ibanEnding(IBAN)).toBe('90154');
  });
});

describe('formatting', () => {
  it('formats the rate with 4 to 6 fraction digits and rejects junk', () => {
    expect(formatRate('0.9213', 'pt-PT')).toBe('0,9213');
    expect(formatRate('0.92', 'pt-PT')).toBe('0,9200');
    expect(formatRate('0.1234567', 'pt-PT')).toBe('0,123457');
    expect(formatRate('abc', 'pt-PT')).toBeNull();
    expect(formatRate('0', 'pt-PT')).toBeNull();
  });
  it('names the country in the locale and falls back to the code', () => {
    expect(locationParts({ city: 'Lisboa', country: 'PT' }, 'pt-PT')).toEqual({
      city: 'Lisboa',
      country: 'Portugal',
    });
    expect(locationParts({ country: 'US' }, 'en')).toEqual({ country: 'United States' });
    expect(locationParts({ city: ' ' }, 'pt-PT')).toBeNull();
    expect(locationParts(null, 'pt-PT')).toBeNull();
  });
  it('converts decimal prices to minor units and finds symbols', () => {
    expect(decimalToMinor('0.24', 'USD')).toBe(24);
    expect(decimalToMinor('1500', 'JPY')).toBe(1500);
    expect(decimalToMinor('x', 'EUR')).toBeNull();
    expect(currencySymbol('EUR', 'pt-PT')).toBe('€');
  });
});

describe('buildDetails', () => {
  it('has no extra rows for a bare row (no empty "-" lines)', () => {
    const model = build();
    expect(model.main).toEqual([]);
    expect(ids(model.more)).toEqual(['original', 'source']);
    expect(model.lead).toMatchObject({ id: 'purchaseDate' });
    expect(model.lead).not.toHaveProperty('bookedOn');
  });

  it('leaves the disclosure empty when nothing is left to show', () => {
    expect(build({ rawDescription: ' ' }).more.map((f) => f.id)).toEqual(['source']);
  });

  it('uses the purchase date and shows the booking date when they differ', () => {
    const model = build({ transactionDate: '2026-10-12' });
    expect(model.lead).toMatchObject({ id: 'purchaseDate', bookedOn: expect.any(String) });
    expect(purchaseDay({ ...tx, transactionDate: '2026-10-12' }, 'Europe/Lisbon')).toBe(
      '2026-10-12',
    );
  });

  it('takes the purchase day from occurredAt in the household zone, with the time', () => {
    // 23:30 UTC on the 13th is 00:30 on the 14th in Lisbon (UTC+1), still the 13th in New York.
    const occurredAt = '2026-10-13T23:30:00.000Z';
    expect(purchaseDay({ ...tx, occurredAt }, 'Europe/Lisbon')).toBe('2026-10-14');
    expect(purchaseDay({ ...tx, occurredAt }, 'America/New_York')).toBe('2026-10-13');
    const lead = build({ occurredAt }).lead;
    expect(lead).toMatchObject({ id: 'purchaseDate' });
    expect((lead as { value: string }).value).toMatch(/\d{2}:\d{2}/);
    expect(lead).not.toHaveProperty('bookedOn');
  });

  it('adds merchant, location, original amount with rate, and reference in order', () => {
    const model = build(
      {
        merchant: { name: 'Amazon', domain: 'amazon.es' },
        location: { city: 'Madrid', country: 'ES' },
      },
      {
        originalAmount: { amount: -2000, currency: 'USD' },
        exchangeRate: '0.9213',
        reference: 'REF-1',
      },
    );
    expect(ids(model.main)).toEqual(['merchant', 'location', 'originalAmount', 'reference']);
    // The title already says "Amazon": the row only adds the website.
    expect(model.main[0]).toEqual({ id: 'merchant', domain: 'amazon.es' });
    expect(model.main[2]).toEqual({
      id: 'originalAmount',
      amount: -2000,
      currency: 'USD',
      rate: { from: 'USD', value: '0,9213', to: '€' },
    });
  });

  it('leaves out the merchant row when it would only repeat the title', () => {
    expect(ids(build({ merchant: { name: 'Amazon', domain: null } }).main)).toEqual([]);
  });

  it('omits the rate without a valid number and the original amount without details', () => {
    expect(
      build({}, { originalAmount: { amount: 5, currency: 'USD' }, exchangeRate: 'n/a' }).main[0],
    ).not.toHaveProperty('rate');
    expect(ids(build({}, { exchangeRate: '0.9' }).main)).toEqual([]);
  });

  it('labels the counterparty account by direction and keeps the full IBAN', () => {
    const out = build({ amount: -100 }, { counterpartyAccount: { iban: IBAN } }).main[0];
    const inn = build({ amount: 100 }, { counterpartyAccount: { iban: IBAN } }).main[0];
    expect(out).toEqual({ id: 'counterparty', label: 'toAccount', iban: compactIban(IBAN) });
    expect(inn).toMatchObject({ label: 'fromAccount' });
    expect(build({}, { counterpartyAccount: { other: '123' } }).main[0]).toMatchObject({
      other: '123',
    });
    expect(build({}, { counterpartyAccount: { bic: 'BCOMPTPL' } }).main).toEqual([]);
  });

  it('describes a dividend instrument with shares and price', () => {
    const f = build(
      { currency: 'EUR' },
      {
        instrument: { ticker: 'AAPL', quantity: '10', pricePerShare: '0.24' },
        originalAmount: { amount: 240, currency: 'USD' },
      },
    ).main.find((x) => x.id === 'instrument');
    expect(f).toEqual({
      id: 'instrument',
      ticker: 'AAPL',
      shares: 10,
      price: { minor: 24, currency: 'USD' },
    });
  });

  it('puts the technical fields behind the disclosure, with MCC label in the locale', () => {
    const model = build(
      { mcc: '5411', valueDate: '2026-10-15', location: null },
      {
        remittance: ['linha 1', 'linha 2'],
        bankCode: { code: 'PMNT', subCode: 'CCRD' },
        counterpartyAccount: { bic: 'BCOMPTPL' },
        balanceAfter: { amount: 10000, currency: 'EUR' },
        providerType: 'CARD',
        merchantCategory: 'Groceries',
      },
    );
    expect(ids(model.more)).toEqual([
      'valueDate',
      'mcc',
      'remittance',
      'bankCode',
      'bic',
      'balanceAfter',
      'providerType',
      'providerCategory',
      'original',
      'source',
    ]);
    const mcc = model.more.find((f) => f.id === 'mcc');
    expect(mcc).toMatchObject({ code: '5411', label: expect.any(String) });
    expect(model.more.find((f) => f.id === 'bankCode')).toEqual({
      id: 'bankCode',
      value: 'PMNT, CCRD',
    });
    expect(build({ mcc: '12' }).more.some((f) => f.id === 'mcc')).toBe(false);
  });

  it('does not repeat a value date equal to the booking date', () => {
    expect(build({ valueDate: '2026-10-14' }).more.some((f) => f.id === 'valueDate')).toBe(false);
  });
});
