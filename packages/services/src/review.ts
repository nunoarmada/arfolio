import { and, eq, sql } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import type { ServiceCtx } from './context.js';
import { queryTransactions, type TransactionPage } from './transactions.js';

/** Transactions waiting for a human decision, newest first. */
export async function listReviewInbox(
  ctx: ServiceCtx,
  opts: { cursor?: string; limit?: number } = {},
): Promise<TransactionPage> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    queryTransactions(tx, ctx, { ...opts, needsReview: true }),
  );
}

export async function reviewCount(ctx: ServiceCtx): Promise<number> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.transaction)
      .where(
        and(
          eq(schema.transaction.householdId, ctx.householdId),
          eq(schema.transaction.needsReview, true),
        ),
      );
    return row?.n ?? 0;
  });
}
