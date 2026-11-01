import { appLanguage, isValidMcc, mccLabel, type TransactionDetails } from '@arfolio/core';
import { txTitle } from './transaction-display';
import { formatDate, formatDateTime, todayIn } from './dates';

/** Pure view model for the "Detalhes" section: what to show, never how (no React here). */

const IBAN_MASK = '•••• …';

/** Upper-case, no spaces: the form that is copied. */
export function compactIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/** Groups of four ("PT50 0002 0123 1234 5678 9015 4"). */
export function groupIban(iban: string): string {
  return compactIban(iban).replace(/(.{4})(?=.)/g, '$1 ');
}

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/;

/**
 * Always masked. An IBAN keeps the country and check digits and its last five characters
 * ("PT50 •••• … 1234 5"); anything that is not IBAN-shaped shows only its last four ("•••• 1234").
 */
export function maskIban(iban: string): string {
  const full = compactIban(iban);
  if (!IBAN_SHAPE.test(full)) return `•••• ${full.slice(-4)}`;
  return `${full.slice(0, 4)} ${IBAN_MASK} ${full.slice(-5, -1)} ${full.slice(-1)}`;
}

/** What a screen reader hears for a hidden IBAN: only its ending. */
export function ibanEnding(iban: string): string {
  const full = compactIban(iban);
  return full.slice(IBAN_SHAPE.test(full) ? -5 : -4);
}

/** City and country name (the name follows the locale); null when neither is known. */
export function locationParts(
  location: { city?: string | undefined; country?: string | undefined } | null | undefined,
  locale: string,
): { city?: string; country?: string } | null {
  if (!location) return null;
  const city = location.city?.trim();
  let country: string | undefined;
  if (location.country) {
    try {
      country = new Intl.DisplayNames([locale], { type: 'region' }).of(location.country);
    } catch {
      country = undefined;
    }
    country ??= location.country;
  }
  if (!city && !country) return null;
  return { ...(city ? { city } : {}), ...(country ? { country } : {}) };
}

/** The rate with 4 to 6 fraction digits ("0,9213"), or null when it is not a number. */
export function formatRate(rate: string, locale: string): string | null {
  const n = Number(rate.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(n);
}

/** The symbol the locale uses for the currency ("€"), falling back to the code. */
export function currencySymbol(currency: string, locale: string): string {
  try {
    return (
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** A decimal string ("0.24") as minor units of the currency, for `formatMoney`. */
export function decimalToMinor(value: string, currency: string): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  let digits: number;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  const minor = Math.round(n * 10 ** digits);
  return Number.isSafeInteger(minor) ? minor : null;
}

export interface DetailTx {
  bookingDate: string;
  valueDate: string | null;
  transactionDate: string | null;
  occurredAt: string | null;
  amount: number;
  currency: string;
  rawDescription: string;
  counterparty?: string | null | undefined;
  mcc: string | null;
  source: 'connector' | 'import' | 'manual';
  merchant?: { name: string; domain: string | null } | null | undefined;
  location?: { city?: string | undefined; country?: string | undefined } | null | undefined;
}

export type DetailField =
  | { id: 'purchaseDate'; value: string; bookedOn?: string }
  | { id: 'merchant'; name?: string; domain?: string }
  | { id: 'location'; city?: string; country?: string }
  | {
      id: 'originalAmount';
      amount: number;
      currency: string;
      rate?: { from: string; value: string; to: string };
    }
  | { id: 'counterparty'; label: 'toAccount' | 'fromAccount'; iban?: string; other?: string }
  | { id: 'reference'; value: string }
  | {
      id: 'instrument';
      ticker: string;
      shares?: number;
      price?: { minor: number; currency: string };
    }
  | { id: 'valueDate'; value: string }
  | { id: 'mcc'; code: string; label?: string }
  | { id: 'remittance'; lines: string[] }
  | { id: 'bankCode'; value: string }
  | { id: 'bic'; value: string }
  | { id: 'balanceAfter'; amount: number; currency: string }
  | { id: 'providerType'; value: string }
  | { id: 'providerCategory'; value: string }
  | { id: 'original'; value: string }
  | { id: 'source'; source: DetailTx['source'] };

export interface DetailsModel {
  /** The purchase date, always first. */
  lead: DetailField;
  /** Shown after account, status and category, in this order; absent fields are left out. */
  main: DetailField[];
  /** Behind "Mais detalhes". */
  more: DetailField[];
}

/** The calendar day of the purchase in the household zone (the bank's date when no instant). */
export function purchaseDay(tx: DetailTx, timeZone: string): string {
  if (tx.occurredAt) return todayIn(timeZone, new Date(tx.occurredAt));
  return tx.transactionDate ?? tx.bookingDate;
}

export function buildDetails(
  tx: DetailTx,
  details: TransactionDetails | null | undefined,
  locale: string,
  timeZone: string,
): DetailsModel {
  const day = purchaseDay(tx, timeZone);
  const lead: DetailField = {
    id: 'purchaseDate',
    value: tx.occurredAt
      ? formatDateTime(tx.occurredAt, locale, timeZone)
      : formatDate(day, locale),
    ...(day !== tx.bookingDate ? { bookedOn: formatDate(tx.bookingDate, locale) } : {}),
  };

  const main: DetailField[] = [];
  const merchantName = tx.merchant?.name.trim();
  if (merchantName) {
    const domain = tx.merchant?.domain?.trim();
    // The title already says the name: repeat it only when the title shows something else.
    const title = txTitle({
      counterparty: tx.counterparty ?? null,
      rawDescription: tx.rawDescription,
      merchant: tx.merchant ?? null,
    });
    if (merchantName !== title) {
      main.push({ id: 'merchant', name: merchantName, ...(domain ? { domain } : {}) });
    } else if (domain) {
      main.push({ id: 'merchant', domain });
    }
  }
  const place = locationParts(tx.location ?? details?.location, locale);
  if (place) main.push({ id: 'location', ...place });

  if (details?.originalAmount) {
    const { amount, currency } = details.originalAmount;
    const rate = details.exchangeRate ? formatRate(details.exchangeRate, locale) : null;
    main.push({
      id: 'originalAmount',
      amount,
      currency,
      ...(rate
        ? { rate: { from: currency, value: rate, to: currencySymbol(tx.currency, locale) } }
        : {}),
    });
  }

  const account = details?.counterpartyAccount;
  if (account?.iban || account?.other) {
    main.push({
      id: 'counterparty',
      label: tx.amount < 0 ? 'toAccount' : 'fromAccount',
      ...(account.iban ? { iban: compactIban(account.iban) } : { other: account.other! }),
    });
  }

  const reference = details?.reference ?? details?.entryReference;
  if (reference) main.push({ id: 'reference', value: reference });

  const instrument = details?.instrument;
  const ticker = instrument?.ticker ?? instrument?.name;
  if (instrument && ticker) {
    const shares = instrument.quantity === undefined ? NaN : Number(instrument.quantity);
    const minor = instrument.pricePerShare
      ? decimalToMinor(instrument.pricePerShare, details?.originalAmount?.currency ?? tx.currency)
      : null;
    main.push({
      id: 'instrument',
      ticker,
      ...(Number.isFinite(shares) ? { shares } : {}),
      ...(minor !== null
        ? { price: { minor, currency: details?.originalAmount?.currency ?? tx.currency } }
        : {}),
    });
  }

  const more: DetailField[] = [];
  if (tx.valueDate && tx.valueDate !== tx.bookingDate) {
    more.push({ id: 'valueDate', value: formatDate(tx.valueDate, locale) });
  }
  if (isValidMcc(tx.mcc)) {
    const label = mccLabel(tx.mcc, appLanguage(locale));
    more.push({ id: 'mcc', code: tx.mcc, ...(label ? { label } : {}) });
  }
  const lines = details?.remittance?.length
    ? details.remittance
    : details?.note
      ? [details.note]
      : [];
  if (lines.length) more.push({ id: 'remittance', lines });
  const code = details?.bankCode;
  const bankCode = [code?.code, code?.subCode, code?.description].filter(Boolean).join(', ');
  if (bankCode) more.push({ id: 'bankCode', value: bankCode });
  if (account?.bic) more.push({ id: 'bic', value: account.bic });
  if (details?.balanceAfter) {
    more.push({ id: 'balanceAfter', ...details.balanceAfter });
  }
  if (details?.providerType) more.push({ id: 'providerType', value: details.providerType });
  if (details?.merchantCategory) {
    more.push({ id: 'providerCategory', value: details.merchantCategory });
  }
  if (tx.rawDescription.trim()) more.push({ id: 'original', value: tx.rawDescription });
  more.push({ id: 'source', source: tx.source });

  return { lead, main, more };
}
