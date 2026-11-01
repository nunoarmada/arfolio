export type BudgetKind = 'income' | 'expense' | 'saving';

export type ActualRow = {
  /** Signed minor units (outflow negative). */
  amount: number;
  /** Part of a transfer between household accounts: never income or expense. */
  isTransfer: boolean;
  status: 'booked' | 'pending';
  currency: string;
  /** The row's category is linked to the line. */
  categoryLinked: boolean;
  /** The account the row was booked on. */
  accountId: string | null;
};

/** Where a saving line's actual comes from. */
export type SavingSource = 'account' | 'categories';

export type LineActual = {
  /** Booked amount in the household currency, display sign (see computeLineActual). */
  actual: number;
  /** Same formula over pending rows; never part of `actual`. */
  pending: number;
  /** Relevant rows in another currency: counted, never summed (no FX). */
  foreignCurrencyRows: number;
};

/**
 * Reference implementation of the actuals rules (the services compute the same thing in SQL, and
 * a parity test keeps the two aligned).
 *
 * - expense: -sum(signed) over non-transfer rows in linked categories (a refund reduces it and
 *   may take it negative);
 * - income: sum(signed) over the same rows;
 * - saving: no split between lines; only money traceable to the line counts (shared accounts are
 *   the services' "unassigned"). `opts.source` picks the rule:
 *   - 'account' (the sole whole-account line, not the hub): every row booked on `opts.accountId`
 *     counts signed, transfer or not and whatever its category, so category rows on that account
 *     are not counted twice; linked-category rows on other accounts still count as -sum(signed);
 *   - 'categories' (default): -sum(signed) over non-transfer rows in linked categories, leaving
 *     out rows booked on the line's own non-hub account (those belong to the account rule).
 *
 * The hub account never receives account flow: 'account' on the hub behaves as 'categories'.
 * `source` is ignored for income and expense.
 *
 * Only household-currency rows are summed; `pending` uses the same formula over pending rows.
 */
export function computeLineActual(
  kind: BudgetKind,
  rows: readonly ActualRow[],
  opts: {
    currency: string;
    accountId: string | null;
    hubAccountId?: string | null;
    source?: SavingSource;
  },
): LineActual {
  const lineAccount =
    kind === 'saving' && opts.accountId !== null && opts.accountId !== opts.hubAccountId
      ? opts.accountId
      : null;
  const wholeAccount = lineAccount !== null && opts.source === 'account';
  const sums = { booked: 0, pending: 0 };
  let foreignCurrencyRows = 0;

  for (const r of rows) {
    let contribution: number | null = null;
    if (lineAccount !== null && r.accountId === lineAccount) {
      if (wholeAccount) contribution = r.amount;
    } else if (!r.isTransfer && r.categoryLinked) {
      contribution = kind === 'income' ? r.amount : -r.amount;
    }
    if (contribution === null) continue;
    if (r.currency !== opts.currency) {
      foreignCurrencyRows += 1;
      continue;
    }
    sums[r.status] += contribution;
  }

  return { actual: sums.booked, pending: sums.pending, foreignCurrencyRows };
}
