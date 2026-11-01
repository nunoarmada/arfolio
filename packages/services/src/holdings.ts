import { and, asc, desc, eq, max } from 'drizzle-orm';
import { minorDecimal } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import { assertUuid, NotFoundError, type ServiceCtx } from './context.js';

const { financialAccount, positionSnapshot, investmentBucket } = schema;

export interface Holding {
  ticker: string;
  name: string;
  isin: string | null;
  /** Currency of `value`, `cost` and `profit`; differs from the account's for foreign positions. */
  currency: string;
  quantity: string;
  value: string;
  /** Null when the snapshot predates stored costs. */
  cost: string | null;
  profit: string | null;
  /** Profit over cost in basis points; null when cost or profit is unknown, or cost is 0. */
  profitBps: number | null;
  /** Share of the account-currency total in basis points; null for foreign positions or a 0 total. */
  weightBps: number | null;
}

export interface Holdings {
  asOf: string | null;
  currency: string | null;
  /** Sum of the account-currency positions only, as in net worth (foreign ones are separate). */
  total: string;
  items: Holding[];
}

/** a / b rounded half away from zero, in BigInt (b > 0). */
function ratioBps(a: bigint, b: bigint): number {
  const scaled = a * 10_000n;
  const half = b / 2n;
  const q = scaled >= 0n ? (scaled + half) / b : -((-scaled + half) / b);
  return Number(q);
}

/** A numeric(28,10) string without trailing zeros ("2.5000000000" becomes "2.5"). */
function trimDecimal(q: string): string {
  return q.includes('.') ? q.replace(/\.?0+$/, '') : q;
}

/**
 * The account's holdings on its latest snapshot day, largest first (account-currency positions,
 * then foreign ones). Money is exact decimal strings. Positions in another currency than the
 * account's are listed in their own currency but kept out of the total and weights, like the
 * net-worth code does. Readable by every role.
 */
export async function listHoldings(ctx: ServiceCtx, accountId: string): Promise<Holdings> {
  assertUuid(accountId, 'Account');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [account] = await tx
      .select({ currency: financialAccount.currency })
      .from(financialAccount)
      .where(
        and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
      );
    if (!account) throw new NotFoundError('Account');
    const scope = and(
      eq(positionSnapshot.householdId, ctx.householdId),
      eq(positionSnapshot.accountId, accountId),
    );
    const [latest] = await tx
      .select({ asOf: max(positionSnapshot.asOf) })
      .from(positionSnapshot)
      .where(scope);
    if (!latest?.asOf)
      return {
        asOf: null,
        currency: account.currency,
        total: minorDecimal(0, account.currency),
        items: [],
      };
    const rows = await tx
      .select()
      .from(positionSnapshot)
      .where(and(scope, eq(positionSnapshot.asOf, latest.asOf)))
      .orderBy(desc(positionSnapshot.valueMinor), positionSnapshot.instrument);

    const home = account.currency;
    const total = rows
      .filter((r) => r.currency === home)
      .reduce((sum, r) => sum + BigInt(r.valueMinor), 0n);
    const items = rows.map((r): Holding => {
      const value = BigInt(r.valueMinor);
      const cost = r.costMinor === null ? null : BigInt(r.costMinor);
      const profit =
        cost === null || r.unrealizedPlMinor === null ? null : BigInt(r.unrealizedPlMinor);
      return {
        ticker: r.ticker ?? r.instrument,
        name: r.name ?? r.ticker ?? r.instrument,
        isin: r.isin,
        currency: r.currency,
        quantity: trimDecimal(r.quantity),
        value: minorDecimal(value, r.currency),
        cost: cost === null ? null : minorDecimal(cost, r.currency),
        profit: profit === null ? null : minorDecimal(profit, r.currency),
        profitBps: cost !== null && cost > 0n && profit !== null ? ratioBps(profit, cost) : null,
        weightBps: r.currency === home && total > 0n ? ratioBps(value, total) : null,
      };
    });
    items.sort((x, y) => Number(y.currency === home) - Number(x.currency === home));
    return { asOf: latest.asOf, currency: home, total: minorDecimal(total, home), items };
  });
}

/**
 * The investment pies (buckets) of the account, ordered by name, removed ones flagged: the
 * candidates a saving budget line can be linked to. Readable by every role.
 */
export async function listAccountBuckets(
  ctx: ServiceCtx,
  accountId: string,
): Promise<Array<{ id: string; name: string; removed: boolean }>> {
  assertUuid(accountId, 'Account');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [account] = await tx
      .select({ id: financialAccount.id })
      .from(financialAccount)
      .where(
        and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
      );
    if (!account) throw new NotFoundError('Account');
    const rows = await tx
      .select({
        id: investmentBucket.id,
        name: investmentBucket.name,
        removedAt: investmentBucket.removedAt,
      })
      .from(investmentBucket)
      .where(
        and(
          eq(investmentBucket.householdId, ctx.householdId),
          eq(investmentBucket.accountId, accountId),
        ),
      )
      .orderBy(asc(investmentBucket.name), asc(investmentBucket.id));
    return rows.map((r) => ({ id: r.id, name: r.name, removed: r.removedAt !== null }));
  });
}
