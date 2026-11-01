import { isValidMcc, parseTransactionDetails } from '@arfolio/core';
import {
  isRecord,
  minorFromDecimalString,
  optIsoDate,
  optString,
  record,
  reqString,
  type Json,
} from '../guards.js';
import { ProviderResponseError, type ProviderBalance, type ProviderTx } from '../types.js';

const MAX_EXTERNAL_ID = 200;
const MAX_DESCRIPTION = 1_000;
const MAX_COUNTERPARTY = 300;
const FALLBACK_DESCRIPTION = '(no description)';

/** CNCL/RJCT transactions never moved money: callers skip them instead of mapping. */
export function isIngestibleEnableBankingStatus(status: unknown): boolean {
  const code = trimmedStatus(status);
  return code !== 'CNCL' && code !== 'RJCT';
}

/** Banks occasionally pad status codes: every comparison uses the trimmed value. */
function trimmedStatus(status: unknown): string | undefined {
  return typeof status === 'string' ? status.trim() : undefined;
}

function remittance(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return optString(raw);
  const joined = raw
    .map((line) => optString(line))
    .filter((line): line is string => line !== undefined)
    .join(' ');
  return joined === '' ? undefined : joined;
}

/**
 * Minor units of an `{ amount, currency }` object, or undefined when it is malformed. With `sign`
 * the magnitude is re-signed (amounts that follow the credit/debit indicator).
 */
function moneyOf(raw: unknown, sign?: 1 | -1): { amount: number; currency: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const currency = optString(raw.currency);
  if (currency === undefined) return undefined;
  try {
    const given = minorFromDecimalString(raw.amount, currency, 'amount');
    // Without `sign` the provider's own sign is kept (a balance can be negative).
    return { amount: sign === undefined ? given : sign * Math.abs(given), currency };
  } catch {
    return undefined;
  }
}

/** First simple id of `*_account_additional_identification` (strings or `{ identification }`). */
function additionalId(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const item of raw) {
    const id = optString(isRecord(item) ? item.identification : item);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** The account and agent BIC of the party opposite the credit/debit indicator. */
function counterpartyAccount(tx: Json, indicator: 'CRDT' | 'DBIT') {
  const side = indicator === 'DBIT' ? 'creditor' : 'debtor';
  const account = tx[`${side}_account`];
  const agent = tx[`${side}_agent`];
  const other = isRecord(account) && isRecord(account.other) ? account.other : undefined;
  return {
    iban: isRecord(account) ? optString(account.iban) : undefined,
    other:
      optString(other?.identification) ??
      additionalId(tx[`${side}_account_additional_identification`]),
    bic: isRecord(agent) ? optString(agent.bic_fi) : undefined,
  };
}

/** Every provider field without a typed column; the details schema drops invalid values. */
function transactionDetails(tx: Json, indicator: 'CRDT' | 'DBIT', currency: string) {
  const sign = indicator === 'DBIT' ? -1 : 1;
  const code = isRecord(tx.bank_transaction_code) ? tx.bank_transaction_code : undefined;
  const fx = isRecord(tx.exchange_rate) ? tx.exchange_rate : undefined;
  const instructed = moneyOf(fx?.instructed_amount, sign);
  const foreign = instructed !== undefined && instructed.currency !== currency;
  return parseTransactionDetails({
    remittance: Array.isArray(tx.remittance_information)
      ? tx.remittance_information
      : [tx.remittance_information],
    note: tx.note,
    reference: tx.reference_number,
    entryReference: tx.entry_reference,
    bankCode: { code: code?.code, subCode: code?.sub_code, description: code?.description },
    counterpartyAccount: counterpartyAccount(tx, indicator),
    ...(foreign ? { originalAmount: instructed, exchangeRate: fx?.exchange_rate } : {}),
    balanceAfter: moneyOf(tx.balance_after_transaction),
  });
}

/**
 * Maps one Enable Banking transaction. The id is `transaction_id ?? entry_reference`, never
 * synthetic: when both are null the row has no `externalId` and falls back to the dedupe hash.
 */
export function mapEnableBankingTransaction(raw: unknown, accountCurrency?: string): ProviderTx {
  const tx = record(raw, 'transaction');

  const code = trimmedStatus(tx.status);
  if (code === undefined || code === '') {
    throw new ProviderResponseError('Unexpected response: transaction status is missing');
  }
  if (!isIngestibleEnableBankingStatus(tx.status)) {
    throw new ProviderResponseError('Unexpected response: transaction status is not ingestible');
  }
  // Unknown non-empty statuses (HOLD, SCHD, OTHR, ...) are treated as pending.
  const status = code === 'BOOK' ? 'booked' : 'pending';

  const indicator = tx.credit_debit_indicator;
  if (indicator !== 'CRDT' && indicator !== 'DBIT') {
    throw new ProviderResponseError('Unexpected response: credit_debit_indicator is invalid');
  }
  const amountObj = record(tx.transaction_amount, 'transaction_amount');
  const currency = optString(amountObj.currency) ?? accountCurrency;
  if (currency === undefined)
    throw new ProviderResponseError('Unexpected response: currency is missing');

  const unsigned = Math.abs(
    minorFromDecimalString(amountObj.amount, currency, 'transaction amount'),
  );
  const amount = indicator === 'DBIT' ? -unsigned : unsigned;
  const valueDate = optIsoDate(tx.value_date);
  const bookingDate = optIsoDate(tx.booking_date) ?? valueDate ?? optIsoDate(tx.transaction_date);
  if (bookingDate === undefined)
    throw new ProviderResponseError('Unexpected response: no transaction date');

  const party = indicator === 'DBIT' ? tx.creditor : tx.debtor;
  const counterparty = optString(
    party === null || party === undefined ? undefined : record(party, 'party').name,
  );

  const bankCode = tx.bank_transaction_code;
  const description =
    remittance(tx.remittance_information) ??
    optString(tx.note) ??
    (bankCode !== null && typeof bankCode === 'object' && !Array.isArray(bankCode)
      ? optString((bankCode as Record<string, unknown>).description)
      : undefined) ??
    optString(tx.reference_number) ??
    counterparty ??
    FALLBACK_DESCRIPTION;

  // An id longer than the ingest limit (200) is dropped, not truncated (truncation could collide):
  // the row then takes the dedupe-hash path like a row without ids.
  const externalId = optString(tx.transaction_id) ?? optString(tx.entry_reference);

  const transactionDate = optIsoDate(tx.transaction_date);
  const mcc = isValidMcc(tx.merchant_category_code) ? tx.merchant_category_code : undefined;
  const details = transactionDetails(tx, indicator, currency);

  return {
    ...(externalId !== undefined && externalId.length <= MAX_EXTERNAL_ID ? { externalId } : {}),
    bookingDate,
    ...(valueDate !== undefined ? { valueDate } : {}),
    amount,
    currency,
    description: description.slice(0, MAX_DESCRIPTION),
    ...(counterparty !== undefined
      ? { counterparty: counterparty.slice(0, MAX_COUNTERPARTY) }
      : {}),
    status,
    ...(transactionDate !== undefined ? { transactionDate } : {}),
    ...(mcc !== undefined ? { mcc } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/** Maps one `/balances` entry. `kind` is the ISO 20022 `balance_type` (CLBD, ITAV, ...). */
export function mapEnableBankingBalance(
  raw: unknown,
  externalUid: string,
  fallbackAsOf: string,
): ProviderBalance {
  const b = record(raw, 'balance');
  const amount = record(b.balance_amount, 'balance_amount');
  const currency = reqString(amount.currency, 'balance currency');
  return {
    externalUid,
    asOf: optString(b.reference_date) ?? optString(b.last_change_date_time) ?? fallbackAsOf,
    amount: minorFromDecimalString(amount.amount, currency, 'balance amount'),
    currency,
    kind: reqString(b.balance_type, 'balance_type'),
  };
}
