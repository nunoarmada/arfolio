import type { BudgetKind } from './budget-status';

/** The category filter caps at this many ids (see transaction-filters). */
const MAX_CATEGORIES = 20;

function listUrl(from: string, to: string, extra: Array<[string, string]>): string {
  const params = new URLSearchParams({ period: 'custom', from, to });
  for (const [key, value] of extra) params.append(key, value);
  return `/transactions?${params.toString()}`;
}

/** The actuals count booked rows only, so the lists do too (pending rows are shown apart). */
const BOOKED: [string, string] = ['status', 'booked'];

/**
 * The transactions list a budget line stands for: its categories (a saving line with an account
 * lists that account's booked transfers instead, as the number counts), within the month. Null when nothing identifies its transactions.
 */
export function lineTransactionsLink(
  line: { kind: BudgetKind; accountId: string | null; categoryIds: readonly string[] },
  range: { from: string; to: string },
): string | null {
  if (line.kind === 'saving' && line.accountId) {
    return listUrl(range.from, range.to, [
      ['account', line.accountId],
      ['transfers', 'only'],
      BOOKED,
    ]);
  }
  if (line.categoryIds.length === 0) return null;
  return listUrl(range.from, range.to, [
    ...line.categoryIds.slice(0, MAX_CATEGORIES).map((id): [string, string] => ['category', id]),
    BOOKED,
  ]);
}

/**
 * Spending outside the budget: one category, or the uncategorised outflows when `categoryId` is
 * null (uncategorised inflows are not spending).
 */
export function categoryTransactionsLink(
  categoryId: string | null,
  range: { from: string; to: string },
): string {
  return listUrl(
    range.from,
    range.to,
    categoryId
      ? [['category', categoryId], BOOKED]
      : [['uncategorised', '1'], ['type', 'out'], BOOKED],
  );
}
