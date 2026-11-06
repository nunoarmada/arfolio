import { parseTransactionDetails } from '@arfolio/core';
import { array, minorFromNumber, optIsoDate, optString, record, reqString } from '../guards.js';
import { ProviderResponseError, type ProviderBalance, type ProviderTx } from '../types.js';

const MAX_DESCRIPTION = 1_000;
const MAX_COUNTERPARTY = 300;

/** Account summary with all money in integer minor units of `currency`. */
export type Trading212Summary = {
  externalUid: string;
  currency: string;
  totalValue: number;
  /** availableToTrade + inPies + reservedForOrders. */
  cash: number;
  cashAvailableToTrade: number;
  investmentsValue: number;
};

export type ProviderPosition = {
  ticker: string;
  name: string;
  isin?: string;
  instrumentCurrency: string;
  /** Decimal strings (up to 8 dp), in the instrument currency for prices. */
  quantity: string;
  averagePrice: string;
  currentPrice: string;
  /** Account currency; value/cost/unrealizedProfitLoss/fxImpact are minor units of it. */
  currency: string;
  value: number;
  cost: number;
  unrealizedProfitLoss: number;
  fxImpact?: number;
};

/** One Trading 212 pie: `invested` and `value` are minor units of the account currency. */
export type ProviderPie = {
  id: string;
  invested: number;
  value: number;
};

/** One instrument held in a pie: `invested` and `value` are minor units of the account currency. */
export type ProviderPieInstrument = {
  ticker: string;
  /** Decimal string (up to 8 dp). */
  quantity: string;
  invested: number;
  value: number;
};

/** Pie detail from `GET /equity/pies/{id}`: its name and the instruments it holds. */
export type ProviderPieDetail = {
  name: string;
  instruments: ProviderPieInstrument[];
};

/** Trading 212 documents many numbers as non-null but sends null: absent counts as zero. */
function minorOrZero(value: unknown, currency: string, what: string): number {
  return value === null || value === undefined ? 0 : minorFromNumber(value, currency, what);
}

function decimalString(value: unknown, what: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProviderResponseError(`Unexpected response: ${what} is not a number`);
  }
  const fixed = value.toFixed(8);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/** A date-time without `Z` or an offset is read as UTC (never as the server's local time). */
function asUtc(s: string): string {
  return /T[\d:.]+$/.test(s) ? `${s}Z` : s;
}

/** UTC calendar date of a date-time string. */
function utcDate(value: unknown, what: string): string {
  const s = reqString(value, what);
  const time = Date.parse(asUtc(s));
  if (Number.isNaN(time) || optIsoDate(s) === undefined) {
    throw new ProviderResponseError(`Unexpected response: ${what} is not a date`);
  }
  return new Date(time).toISOString().slice(0, 10);
}

/** Exact UTC instant (ISO 8601) of a value validated by `utcDate`; undefined for a date-only one. */
function utcInstant(value: unknown): string | undefined {
  const s = String(value).trim();
  return s.includes('T') ? new Date(Date.parse(asUtc(s))).toISOString() : undefined;
}

/**
 * History transaction. The doc does not specify the sign of `amount`, so it is normalised by
 * `type`: DEPOSIT is an inflow, WITHDRAW and FEE are outflows, anything else keeps its sign.
 */
export function mapTrading212Transaction(raw: unknown): ProviderTx {
  const item = record(raw, 'transaction');
  const reference = reqString(item.reference, 'transaction reference');
  const type = reqString(item.type, 'transaction type');
  const currency = reqString(item.currency, 'transaction currency');
  const given = minorFromNumber(item.amount, currency, 'transaction amount');
  const amount =
    type === 'DEPOSIT'
      ? Math.abs(given)
      : type === 'WITHDRAW' || type === 'FEE'
        ? -Math.abs(given)
        : given;
  const date = utcDate(item.dateTime, 'transaction dateTime');
  const instant = utcInstant(item.dateTime);
  return {
    externalId: `tx:${reference}`,
    bookingDate: date,
    valueDate: date,
    amount,
    currency,
    description: `${type} ${reference}`.slice(0, MAX_DESCRIPTION),
    status: 'booked',
    transactionDate: date,
    ...(instant !== undefined ? { occurredAt: instant } : {}),
    details: parseTransactionDetails({ providerType: type }),
  };
}

/** Dividend: `amount` is the net amount paid in the account currency. */
export function mapTrading212Dividend(raw: unknown): ProviderTx {
  const item = record(raw, 'dividend');
  const reference = reqString(item.reference, 'dividend reference');
  const date = utcDate(item.paidOn, 'dividend paidOn');
  const paidInstant = utcInstant(item.paidOn);
  const currency = reqString(item.currency, 'dividend currency');
  const instrument =
    item.instrument === undefined || item.instrument === null
      ? {}
      : record(item.instrument, 'instrument');
  const counterparty = optString(instrument.name);
  const quantity =
    typeof item.quantity === 'number' ? decimalString(item.quantity, 'quantity') : undefined;
  const perShare =
    typeof item.grossAmountPerShare === 'number'
      ? decimalString(item.grossAmountPerShare, 'grossAmountPerShare')
      : undefined;
  const sized =
    quantity !== undefined && perShare !== undefined ? `${quantity} x ${perShare}` : undefined;
  const instrumentDetails = {
    ticker: item.ticker,
    name: instrument.name,
    quantity,
    pricePerShare: perShare,
  };
  const description = ['Dividend', optString(item.ticker), optString(item.type), sized]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  return {
    externalId: `div:${reference}`,
    bookingDate: date,
    valueDate: date,
    amount: minorFromNumber(item.amount, currency, 'dividend amount'),
    currency,
    description: description.slice(0, MAX_DESCRIPTION),
    ...(counterparty !== undefined
      ? { counterparty: counterparty.slice(0, MAX_COUNTERPARTY) }
      : {}),
    status: 'booked',
    transactionDate: date,
    ...(paidInstant !== undefined ? { occurredAt: paidInstant } : {}),
    details: parseTransactionDetails({ providerType: item.type, instrument: instrumentDetails }),
  };
}

export function parseTrading212Summary(raw: unknown): Trading212Summary {
  const s = record(raw, 'account summary');
  const cash = s.cash === undefined || s.cash === null ? {} : record(s.cash, 'cash');
  const investments =
    s.investments === undefined || s.investments === null
      ? {}
      : record(s.investments, 'investments');
  const id = typeof s.id === 'number' || typeof s.id === 'string' ? String(s.id) : undefined;
  if (id === undefined)
    throw new ProviderResponseError('Unexpected response: account id is missing');
  const currency = reqString(s.currency, 'account currency');
  const available = minorOrZero(cash.availableToTrade, currency, 'availableToTrade');
  return {
    externalUid: id,
    currency,
    totalValue: minorFromNumber(s.totalValue, currency, 'totalValue'),
    cash:
      available +
      minorOrZero(cash.inPies, currency, 'inPies') +
      minorOrZero(cash.reservedForOrders, currency, 'reservedForOrders'),
    cashAvailableToTrade: available,
    investmentsValue: minorOrZero(investments.currentValue, currency, 'investments currentValue'),
  };
}

/** Snapshots: `cash` (all cash buckets), `investments` (market value) and `total` (net worth). */
export function mapTrading212Balances(summary: Trading212Summary, asOf: string): ProviderBalance[] {
  const base = { externalUid: summary.externalUid, asOf, currency: summary.currency };
  return [
    { ...base, amount: summary.cash, kind: 'cash' },
    { ...base, amount: summary.investmentsValue, kind: 'investments' },
    { ...base, amount: summary.totalValue, kind: 'total' },
  ];
}

export function mapTrading212Position(raw: unknown): ProviderPosition {
  const p = record(raw, 'position');
  const instrument = record(p.instrument, 'instrument');
  const wallet = record(p.walletImpact, 'walletImpact');
  const isin = optString(instrument.isin);
  const currency = reqString(wallet.currency, 'wallet currency');
  const hasFx = wallet.fxImpact !== null && wallet.fxImpact !== undefined;
  return {
    ticker: reqString(instrument.ticker, 'instrument ticker'),
    name: optString(instrument.name) ?? reqString(instrument.ticker, 'instrument ticker'),
    ...(isin !== undefined ? { isin } : {}),
    instrumentCurrency: reqString(instrument.currency, 'instrument currency'),
    quantity: decimalString(p.quantity, 'quantity'),
    averagePrice: decimalString(p.averagePricePaid, 'averagePricePaid'),
    currentPrice: decimalString(p.currentPrice, 'currentPrice'),
    currency,
    value: minorFromNumber(wallet.currentValue, currency, 'wallet currentValue'),
    cost: minorFromNumber(wallet.totalCost, currency, 'wallet totalCost'),
    unrealizedProfitLoss: minorFromNumber(
      wallet.unrealizedProfitLoss,
      currency,
      'wallet unrealizedProfitLoss',
    ),
    ...(hasFx ? { fxImpact: minorFromNumber(wallet.fxImpact, currency, 'wallet fxImpact') } : {}),
  };
}

/** Pie from `GET /equity/pies`; values are decimals in the account currency. */
export function mapTrading212Pie(raw: unknown, currency: string): ProviderPie {
  const p = record(raw, 'pie');
  if (typeof p.id !== 'number' || !Number.isSafeInteger(p.id) || p.id < 0) {
    throw new ProviderResponseError('Unexpected response: pie id is not an integer');
  }
  const result = p.result === undefined || p.result === null ? {} : record(p.result, 'pie result');
  return {
    id: String(p.id),
    invested: minorOrZero(result.priceAvgInvestedValue, currency, 'pie priceAvgInvestedValue'),
    value: minorOrZero(result.priceAvgValue, currency, 'pie priceAvgValue'),
  };
}

/** Pie detail from `GET /equity/pies/{id}`; values are decimals in the account currency. */
export function mapTrading212PieDetail(raw: unknown, currency: string): ProviderPieDetail {
  const detail = record(raw, 'pie detail');
  const name = reqString(record(detail.settings, 'pie settings').name, 'pie name');
  const items =
    detail.instruments === undefined || detail.instruments === null
      ? []
      : array(detail.instruments, 'pie instruments');
  // An instrument listed twice in one pie is merged: storage keys instruments by ticker.
  const merged = new Map<string, ProviderPieInstrument>();
  for (const item of items.map((rawItem) => {
    const item = record(rawItem, 'pie instrument');
    const result =
      item.result === undefined || item.result === null
        ? {}
        : record(item.result, 'pie instrument result');
    return {
      ticker: reqString(item.ticker, 'pie instrument ticker'),
      quantity: decimalString(item.ownedQuantity, 'pie instrument ownedQuantity'),
      invested: minorOrZero(
        result.priceAvgInvestedValue,
        currency,
        'pie instrument priceAvgInvestedValue',
      ),
      value: minorOrZero(result.priceAvgValue, currency, 'pie instrument priceAvgValue'),
    };
  })) {
    const seen = merged.get(item.ticker);
    merged.set(
      item.ticker,
      seen === undefined
        ? item
        : {
            ticker: item.ticker,
            quantity: addDecimal8(seen.quantity, item.quantity),
            invested: seen.invested + item.invested,
            value: seen.value + item.value,
          },
    );
  }
  return { name, instruments: [...merged.values()] };
}

/** Sum of two non-negative decimal strings with at most 8 dp (as `decimalString` makes them). */
function addDecimal8(a: string, b: string): string {
  const units = (s: string) => {
    const [whole = '0', frac = ''] = s.split('.');
    return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0').slice(0, 8));
  };
  const sum = (units(a) + units(b)).toString().padStart(9, '0');
  const fixed = `${sum.slice(0, -8)}.${sum.slice(-8)}`;
  return fixed.replace(/\.?0+$/, '') || '0';
}
