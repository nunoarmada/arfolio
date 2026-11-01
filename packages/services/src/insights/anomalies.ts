import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { minorDecimal, minorDigits } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import { parseInput, type ServiceCtx } from '../context.js';
import { redactForAi } from '../ai/redact.js';
import { toSafeNumber } from '../budgets.js';
import { coveringBudgetView } from './budget-month.js';
import { householdToday } from '../net-worth.js';
import { listRecurring } from '../recurring.js';
import { localDay } from '../sync.js';
import { findTransferCategory, notTransferFilter } from '../transactions.js';
import { addMonths, firstDay, lastDay, MONTH_INPUT, monthKey } from './month.js';

const { transaction, category, categoryGroup, notification } = schema;

// Deterministic anomaly rules over the household currency, booked non-transfer rows (the Phase 5
// transfer rule, `notTransferFilter`). Money is BigInt maths on minor units; amounts leave this
// module as decimal strings in the household currency. Names pass through `redactForAi` because
// they end up in the fact sheet the AI model reads. Large transactions carry the category and the
// date only, never a description.

/**
 * A recurring item's name can be a bank description or counterparty the detection picked up, so
 * the model only gets it when `nameKnown` (the user confirmed or renamed the item); otherwise it
 * gets the category. The UI shows `name` either way.
 */
type RecurringNames = {
  name: string;
  /** Absent in sheets stored before the flag existed, which counts as unknown. */
  nameKnown?: boolean;
  category?: string | null;
};

export type Anomaly =
  | { type: 'category_spike'; categoryId: string; name: string; amount: string; baseline: string }
  | { type: 'budget_overrun'; lineId: string; name: string; actual: string; planned: string }
  | (RecurringNames & { type: 'new_recurring'; amount: string; cadence: string })
  | (RecurringNames & { type: 'recurring_price_change'; before: string; after: string })
  | {
      type: 'large_transaction';
      /** Absent in sheets stored before the id was carried. */
      categoryId?: string;
      categoryName: string;
      amount: string;
      date: string;
    };

/** Spike: at least 1.5x the median of the previous months, and at least this many units more. */
const SPIKE_RATIO = { num: 3n, den: 2n };
const SPIKE_MIN_RISE_UNITS = 50n;
const SPIKE_MIN_PRIOR_MONTHS = 3;
/** Overrun: actual over 110% of planned, and more than this many units over. */
const OVERRUN_PERCENT = 110n;
const OVERRUN_MIN_OVER_UNITS = 25n;
/** Large transaction: at least 3x the category's p90, and at least this many units. */
const LARGE_RATIO = 3n;
const LARGE_MIN_UNITS = 200n;
const LOOKBACK_MONTHS = 6;

const inputSchema = z.strictObject({ month: z.string().regex(MONTH_INPUT, 'expected YYYY-MM') });

const priceChangePayload = z.object({
  name: z.string(),
  recurringId: z.string().optional(),
  previousAmount: z.number().int().safe(),
  amount: z.number().int().safe(),
  currency: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Median of positive integers; an even count averages the two middle values, rounding half up. */
function median(values: number[]): bigint {
  const sorted = values.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]! + 1n) / 2n;
}

const byBigDesc =
  <T>(key: (x: T) => bigint) =>
  (a: T, b: T) =>
    key(a) === key(b) ? 0 : key(a) < key(b) ? 1 : -1;

/**
 * The anomalies of `month` (`yyyy-mm`, or the first day of it), read-only for any role:
 * category spikes, budget overruns, newly detected recurring charges, recurring price changes and
 * single large expenses. See the constants above for the thresholds.
 */
export async function detectAnomalies(
  ctx: ServiceCtx,
  rawInput: { month: string },
): Promise<Anomaly[]> {
  const month = monthKey(parseInput(inputSchema, rawInput).month);
  const { currency, timeZone } = await householdToday(ctx);
  const digits = minorDigits(currency);
  const unit = 10n ** BigInt(digits);
  const dec = (minor: bigint | number) => minorDecimal(minor, currency);
  const name = (text: string) => redactForAi(text);

  const history = {
    from: firstDay(addMonths(month, -LOOKBACK_MONTHS)),
    to: lastDay(addMonths(month, -1)),
  };
  const current = { from: firstDay(month), to: lastDay(month) };

  const raw = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const transferCategoryId = await findTransferCategory(tx, ctx.householdId);
    const own = (from: string, to: string) =>
      and(
        eq(transaction.householdId, ctx.householdId),
        eq(transaction.status, 'booked'),
        eq(transaction.currency, currency),
        gte(transaction.purchaseDate, from),
        lte(transaction.purchaseDate, to),
        notTransferFilter(transferCategoryId),
        eq(categoryGroup.kind, 'expense'),
      );

    // Net spend per category and month, as spendingByGroup counts it: refunds net within the
    // category, and a month clamps at zero.
    const monthExpr = sql<string>`to_char(${transaction.purchaseDate}, 'YYYY-MM')`;
    const perMonth = await tx
      .select({
        categoryId: category.id,
        name: category.name,
        month: monthExpr,
        net: sql<string>`(-sum(${transaction.amount}))::text`,
      })
      .from(transaction)
      .innerJoin(
        category,
        and(
          eq(category.id, transaction.categoryId),
          eq(category.householdId, transaction.householdId),
        ),
      )
      .innerJoin(
        categoryGroup,
        and(
          eq(categoryGroup.id, category.groupId),
          eq(categoryGroup.householdId, category.householdId),
        ),
      )
      .where(own(history.from, current.to))
      .groupBy(category.id, category.name, monthExpr);

    // The p90 of single expense rows per category over the previous months. percentile_disc
    // returns one of the stored values, so it stays an exact integer.
    const p90 = await tx
      .select({
        categoryId: category.id,
        p90: sql<string>`(percentile_disc(0.9) within group (order by -${transaction.amount}))::text`,
      })
      .from(transaction)
      .innerJoin(
        category,
        and(
          eq(category.id, transaction.categoryId),
          eq(category.householdId, transaction.householdId),
        ),
      )
      .innerJoin(
        categoryGroup,
        and(
          eq(categoryGroup.id, category.groupId),
          eq(categoryGroup.householdId, category.householdId),
        ),
      )
      .where(and(own(history.from, history.to), sql`${transaction.amount} < 0`))
      .groupBy(category.id);

    const rows = await tx
      .select({
        categoryName: category.name,
        categoryId: category.id,
        purchaseDate: transaction.purchaseDate,
        amount: transaction.amount,
      })
      .from(transaction)
      .innerJoin(
        category,
        and(
          eq(category.id, transaction.categoryId),
          eq(category.householdId, transaction.householdId),
        ),
      )
      .innerJoin(
        categoryGroup,
        and(
          eq(categoryGroup.id, category.groupId),
          eq(categoryGroup.householdId, category.householdId),
        ),
      )
      .where(and(own(current.from, current.to), sql`${transaction.amount} < 0`));

    // Price changes are stored as notifications by the recurring detection job.
    const priceChanges = await tx
      .select({ payload: notification.payload })
      .from(notification)
      .where(
        and(
          eq(notification.householdId, ctx.householdId),
          eq(notification.kind, 'recurring_price_change'),
          sql`${notification.payload}->>'date' between ${current.from} and ${current.to}`,
        ),
      );
    const categories = await tx
      .select({ id: category.id, name: category.name })
      .from(category)
      .where(eq(category.householdId, ctx.householdId));
    return { perMonth, p90, rows, priceChanges, categories };
  });

  // --- category spikes
  const spikes: Array<{ rise: bigint; anomaly: Anomaly }> = [];
  const byCategory = new Map<string, { name: string; now: number; prior: number[] }>();
  for (const r of raw.perMonth) {
    const net = Math.max(0, toSafeNumber(r.net));
    const entry = byCategory.get(r.categoryId) ?? { name: r.name, now: 0, prior: [] };
    if (r.month === month) entry.now = net;
    else if (net > 0) entry.prior.push(net);
    byCategory.set(r.categoryId, entry);
  }
  for (const [categoryId, c] of byCategory) {
    if (c.now === 0 || c.prior.length < SPIKE_MIN_PRIOR_MONTHS) continue;
    const baseline = median(c.prior);
    const amount = BigInt(c.now);
    if (
      amount * SPIKE_RATIO.den >= baseline * SPIKE_RATIO.num &&
      amount - baseline >= SPIKE_MIN_RISE_UNITS * unit
    ) {
      spikes.push({
        rise: amount - baseline,
        anomaly: {
          type: 'category_spike',
          categoryId,
          name: name(c.name),
          amount: dec(amount),
          baseline: dec(baseline),
        },
      });
    }
  }
  spikes.sort(byBigDesc((s) => s.rise));

  // --- budget overruns: the expense lines of the budget whose year covers the month
  const overruns: Array<{ over: bigint; anomaly: Anomaly }> = [];
  const view = await coveringBudgetView(ctx, month);
  if (view) {
    for (const line of view.lines) {
      if (line.kind !== 'expense') continue;
      const actual = BigInt(line.actual);
      const planned = BigInt(line.planned);
      if (
        actual * 100n > planned * OVERRUN_PERCENT &&
        actual - planned > OVERRUN_MIN_OVER_UNITS * unit
      ) {
        overruns.push({
          over: actual - planned,
          anomaly: {
            type: 'budget_overrun',
            lineId: line.lineId,
            name: name(line.name),
            actual: dec(actual),
            planned: dec(planned),
          },
        });
      }
    }
    overruns.sort(byBigDesc((o) => o.over));
  }

  // --- recurring: newly confirmed this month (in the household time zone) and price changes
  const recurringItems = await listRecurring(ctx, { includeDismissed: true });
  const categoryNames = new Map(raw.categories.map((c) => [c.id, c.name]));
  const categoryOf = (id: string | null | undefined) => {
    const categoryName = id ? categoryNames.get(id) : undefined;
    return categoryName ? name(categoryName) : null;
  };
  const namesOf = (item: (typeof recurringItems)[number] | undefined, shown: string) => ({
    name: name(shown),
    nameKnown: item?.status === 'confirmed',
    category: categoryOf(item?.categoryId),
  });
  const newRecurring = recurringItems
    .filter(
      (r) =>
        // An unconfirmed detection is a guess (the first run would flag every subscription).
        r.status === 'confirmed' &&
        r.source === 'detected' &&
        r.currency === currency &&
        r.amount < 0 &&
        monthKey(localDay(r.createdAt, timeZone)) === month,
    )
    .sort((a, b) => a.amount - b.amount || a.name.localeCompare(b.name))
    .map((r): Anomaly => ({
      type: 'new_recurring',
      ...namesOf(r, r.name),
      amount: dec(-r.amount),
      cadence: r.cadence,
    }));
  const priceChanges = raw.priceChanges
    .flatMap((n) => {
      const p = priceChangePayload.safeParse(n.payload);
      return p.success && p.data.currency === currency ? [p.data] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date))
    .map((p): Anomaly => ({
      type: 'recurring_price_change',
      ...namesOf(
        recurringItems.find((r) => r.id === p.recurringId),
        p.name,
      ),
      before: dec(-p.previousAmount),
      after: dec(-p.amount),
    }));

  // --- large single expenses, against the category's p90 of the previous months
  const p90ByCategory = new Map(raw.p90.map((r) => [r.categoryId, BigInt(r.p90)]));
  const large = raw.rows
    .flatMap((r) => {
      const base = p90ByCategory.get(r.categoryId);
      if (base === undefined) return [];
      const amount = BigInt(-r.amount);
      return amount >= LARGE_RATIO * base && amount >= LARGE_MIN_UNITS * unit
        ? [{ r, amount }]
        : [];
    })
    .sort(
      (a, b) =>
        byBigDesc<{ amount: bigint }>((x) => x.amount)(a, b) ||
        a.r.purchaseDate.localeCompare(b.r.purchaseDate),
    )
    .map(({ r, amount }): Anomaly => ({
      type: 'large_transaction',
      categoryId: r.categoryId,
      categoryName: name(r.categoryName),
      amount: dec(amount),
      date: r.purchaseDate,
    }));

  return [
    ...spikes.map((s) => s.anomaly),
    ...overruns.map((o) => o.anomaly),
    ...newRecurring,
    ...priceChanges,
    ...large,
  ];
}
