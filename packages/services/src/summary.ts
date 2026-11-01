import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withHousehold } from '@arfolio/db';
import { isoDate, parseInput, type ServiceCtx } from './context.js';
import { incomeExpenseRows } from './analytics.js';
import { findTransferCategory } from './transactions.js';

export type MonthSummaryRow = {
  currency: string;
  /** Income, minor units: income-kind net plus uncategorised booked inflows. */
  income: number;
  /** Expense as a positive number, minor units: net of refunds, see `incomeExpenseRows`. */
  expense: number;
  /** Rows counted (booked, not a transfer). */
  count: number;
  /** Of those, rows without a category. */
  uncategorised: number;
};

const rangeSchema = z.strictObject({ from: isoDate, to: isoDate });

/**
 * Income and spending over [from, to] per currency, with the definition of `incomeExpenseRows`.
 * Pending rows and transfers (a row with a transfer group, or one in the transfer category)
 * never count as income or expense.
 */
export async function summariseMonth(
  ctx: ServiceCtx,
  rawRange: { from: string; to: string },
): Promise<MonthSummaryRow[]> {
  const range = parseInput(rangeSchema, rawRange);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const transferCategoryId = await findTransferCategory(tx, ctx.householdId);
    const rows = await incomeExpenseRows(tx, {
      householdId: ctx.householdId,
      from: range.from,
      to: range.to,
      transferCategoryId,
      bucket: sql`''`,
    });
    return rows.map(({ currency, income, expense, count, uncategorised }) => ({
      currency,
      income,
      expense,
      count,
      uncategorised,
    }));
  });
}
