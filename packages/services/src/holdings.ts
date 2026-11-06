import { and, asc, desc, eq, max } from 'drizzle-orm';
import { minorDecimal } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import { assertUuid, NotFoundError, type ServiceCtx } from './context.js';

const { financialAccount, positionSnapshot, investmentBucket, investmentBucketHolding } = schema;

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

/**
 * One pie (`id` is the bucket id) or, with `id` and `name` null, what is held outside pies. Money
 * is in `currency` (the account's) and sums the account-currency items only.
 */
export interface HoldingGroup {
  id: string | null;
  name: string | null;
  currency: string;
  value: string;
  /** Null when an item's cost is unknown. */
  cost: string | null;
  profit: string | null;
  profitBps: number | null;
  /** Share of the holdings total in basis points; null for a 0 total. */
  weightBps: number | null;
  items: Holding[];
}

export interface Holdings {
  asOf: string | null;
  currency: string | null;
  /** Sum of the account-currency positions only, as in net worth (foreign ones are separate). */
  total: string;
  items: Holding[];
  /**
   * The holdings by pie (largest first) and then outside pies, from the latest day the pies'
   * instruments were read; null when the account has none.
   */
  groups: HoldingGroup[] | null;
}

/** a / b rounded half away from zero, in BigInt (b > 0). */
function ratioBps(a: bigint, b: bigint): number {
  const scaled = a * 10_000n;
  const half = b / 2n;
  const q = scaled >= 0n ? (scaled + half) / b : -((-scaled + half) / b);
  return Number(q);
}

const QTY_SCALE = 10;

/** A numeric(28,10) string as an integer of 1e-10 units. */
function qtyUnits(q: string): bigint {
  const [whole = '0', frac = ''] = q.split('.');
  const negative = whole.startsWith('-');
  const units =
    BigInt(whole.replace('-', '') || '0') * 10n ** BigInt(QTY_SCALE) +
    BigInt(frac.padEnd(QTY_SCALE, '0').slice(0, QTY_SCALE) || '0');
  return negative ? -units : units;
}

/** Integer of 1e-10 units back to a trimmed decimal string. */
function qtyString(units: bigint): string {
  const negative = units < 0n;
  const abs = (negative ? -units : units).toString().padStart(QTY_SCALE + 1, '0');
  const s = `${abs.slice(0, -QTY_SCALE)}.${abs.slice(-QTY_SCALE)}`;
  return (negative ? '-' : '') + trimDecimal(s);
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
        groups: null,
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

    const holdingScope = and(
      eq(investmentBucketHolding.householdId, ctx.householdId),
      eq(investmentBucketHolding.accountId, accountId),
    );
    const [pieDay] = await tx
      .select({ asOf: max(investmentBucketHolding.asOf) })
      .from(investmentBucketHolding)
      .where(holdingScope);
    let groups: HoldingGroup[] | null = null;
    if (pieDay?.asOf) {
      const held = await tx
        .select({
          bucketId: investmentBucketHolding.bucketId,
          name: investmentBucket.name,
          ticker: investmentBucketHolding.ticker,
          quantity: investmentBucketHolding.quantity,
          investedMinor: investmentBucketHolding.investedMinor,
          valueMinor: investmentBucketHolding.valueMinor,
          currency: investmentBucketHolding.currency,
        })
        .from(investmentBucketHolding)
        .innerJoin(
          investmentBucket,
          and(
            eq(investmentBucket.id, investmentBucketHolding.bucketId),
            eq(investmentBucket.householdId, investmentBucketHolding.householdId),
          ),
        )
        .where(and(holdingScope, eq(investmentBucketHolding.asOf, pieDay.asOf)));
      groups = groupByPie(rows, held, home, total);
    }
    return { asOf: latest.asOf, currency: home, total: minorDecimal(total, home), items, groups };
  });
}

type PositionRow = typeof positionSnapshot.$inferSelect;
type HeldRow = {
  bucketId: string;
  name: string;
  ticker: string;
  quantity: string;
  investedMinor: number;
  valueMinor: number;
  currency: string;
};

function holdingOf(
  base: { ticker: string; name: string; isin: string | null; currency: string; quantity: string },
  value: bigint,
  cost: bigint | null,
  profit: bigint | null,
  home: string,
  total: bigint,
): Holding {
  return {
    ...base,
    value: minorDecimal(value, base.currency),
    cost: cost === null ? null : minorDecimal(cost, base.currency),
    profit: profit === null ? null : minorDecimal(profit, base.currency),
    profitBps: cost !== null && cost > 0n && profit !== null ? ratioBps(profit, cost) : null,
    weightBps: base.currency === home && total > 0n ? ratioBps(value, total) : null,
  };
}

function groupOf(
  id: string | null,
  name: string | null,
  items: Array<{ holding: Holding; value: bigint; cost: bigint | null }>,
  home: string,
  total: bigint,
): HoldingGroup {
  const own = items.filter((i) => i.holding.currency === home);
  const value = own.reduce((sum, i) => sum + i.value, 0n);
  const known = own.every((i) => i.cost !== null);
  const cost = known ? own.reduce((sum, i) => sum + i.cost!, 0n) : null;
  const profit = cost === null ? null : value - cost;
  const sorted = [...items].sort(
    (x, y) =>
      Number(y.holding.currency === home) - Number(x.holding.currency === home) ||
      (y.value > x.value ? 1 : y.value < x.value ? -1 : 0),
  );
  return {
    id,
    name,
    currency: home,
    value: minorDecimal(value, home),
    cost: cost === null ? null : minorDecimal(cost, home),
    profit: profit === null ? null : minorDecimal(profit, home),
    profitBps: cost !== null && cost > 0n && profit !== null ? ratioBps(profit, cost) : null,
    weightBps: total > 0n ? ratioBps(value, total) : null,
    items: sorted.map((i) => i.holding),
  };
}

/**
 * Pies with the instruments Trading 212 reports for each (its own invested and value), then the
 * part of every position not held in a pie: quantity, value and cost minus the pies' totals.
 * A remainder of zero or less (all in pies, or pie data newer than the positions) is left out.
 */
function groupByPie(
  positions: PositionRow[],
  held: HeldRow[],
  home: string,
  total: bigint,
): HoldingGroup[] {
  const byTicker = new Map<string, PositionRow>();
  for (const p of positions) if (p.ticker && p.currency === home) byTicker.set(p.ticker, p);

  const pies = new Map<string, { name: string; rows: HeldRow[] }>();
  const inPies = new Map<string, { quantity: bigint; value: bigint; cost: bigint }>();
  for (const r of held) {
    const pie = pies.get(r.bucketId) ?? { name: r.name, rows: [] };
    pie.rows.push(r);
    pies.set(r.bucketId, pie);
    const sum = inPies.get(r.ticker) ?? { quantity: 0n, value: 0n, cost: 0n };
    inPies.set(r.ticker, {
      quantity: sum.quantity + qtyUnits(r.quantity),
      value: sum.value + BigInt(r.valueMinor),
      cost: sum.cost + BigInt(r.investedMinor),
    });
  }

  const pieGroups = [...pies]
    .map(([id, pie]) => ({
      id,
      name: pie.name,
      value: pie.rows.reduce((sum, r) => sum + BigInt(r.valueMinor), 0n),
      items: pie.rows.map((r) => {
        const position = byTicker.get(r.ticker);
        const value = BigInt(r.valueMinor);
        const cost = BigInt(r.investedMinor);
        const holding = holdingOf(
          {
            ticker: r.ticker,
            name: position?.name ?? r.ticker,
            isin: position?.isin ?? null,
            currency: r.currency,
            quantity: qtyString(qtyUnits(r.quantity)),
          },
          value,
          cost,
          value - cost,
          home,
          total,
        );
        return { holding, value, cost };
      }),
    }))
    .sort((x, y) => (y.value > x.value ? 1 : y.value < x.value ? -1 : 0))
    .map((pie) => groupOf(pie.id, pie.name, pie.items, home, total));

  const outside = positions.flatMap((p) => {
    const base = {
      ticker: p.ticker ?? p.instrument,
      name: p.name ?? p.ticker ?? p.instrument,
      isin: p.isin,
      currency: p.currency,
    };
    const value = BigInt(p.valueMinor);
    const cost = p.costMinor === null ? null : BigInt(p.costMinor);
    const pied = p.ticker && p.currency === home ? inPies.get(p.ticker) : undefined;
    if (!pied) {
      const profit =
        cost === null || p.unrealizedPlMinor === null ? null : BigInt(p.unrealizedPlMinor);
      const holding = holdingOf(
        { ...base, quantity: trimDecimal(p.quantity) },
        value,
        cost,
        profit,
        home,
        total,
      );
      return [{ holding, value, cost: profit === null ? null : cost }];
    }
    const quantity = qtyUnits(p.quantity) - pied.quantity;
    const rest = value - pied.value;
    if (quantity <= 0n || rest < 0n) return [];
    // The pie's invested basis can exceed the position's cost (different averaging): unknown then.
    const restCost = cost === null || cost - pied.cost < 0n ? null : cost - pied.cost;
    const holding = holdingOf(
      { ...base, quantity: qtyString(quantity) },
      rest,
      restCost,
      restCost === null ? null : rest - restCost,
      home,
      total,
    );
    return [{ holding, value: rest, cost: restCost }];
  });

  return outside.length > 0 ? [...pieGroups, groupOf(null, null, outside, home, total)] : pieGroups;
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
