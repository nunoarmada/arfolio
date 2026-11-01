/** What a list row calls itself and which money rule it follows; usable on server and client. */

export type MoneyKindOfTx = 'transfer' | 'expense' | 'income';

/** A provider operation code followed by its reference id (Trading 212: `TYPE <uuid>`). */
const OPERATION_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\s+[0-9a-f]{8}-[0-9a-f-]{4,}$/;

/**
 * The provider operation code when the raw description is nothing but one and its reference
 * (e.g. `INTEREST_ON_FREE_CASH 01a11e3a-83a2-…`), else null.
 */
export function operationCode(rawDescription: string): string | null {
  return OPERATION_CODE.exec(rawDescription.trim())?.[1] ?? null;
}

/** `INTEREST_ON_FREE_CASH` → `Interest on free cash`: the fallback for a code without a label. */
export function humaniseCode(code: string): string {
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The line the user recognises: the enriched merchant name first, then the counterparty the bank
 * gives, then a readable name for a bare operation code (via `operationLabel`, when given), then
 * the raw description.
 */
export function txTitle(
  tx: {
    counterparty: string | null;
    rawDescription: string;
    merchant?: { name: string } | null;
  },
  operationLabel?: (code: string) => string,
): string {
  const named = tx.merchant?.name?.trim() || tx.counterparty?.trim();
  if (named) return named;
  const code = operationLabel ? operationCode(tx.rawDescription) : null;
  return code ? operationLabel!(code) : tx.rawDescription;
}

export function moneyKindOf(tx: { transferGroupId: string | null; amount: number }): MoneyKindOfTx {
  if (tx.transferGroupId) return 'transfer';
  return tx.amount < 0 ? 'expense' : 'income';
}
