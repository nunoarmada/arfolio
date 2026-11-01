import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isValidTimezone, splitByWeights } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  calendarDate,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { savingFlowByMonthInTx, toSafeNumber } from './budgets.js';
import { findTransferCategory, notTransferFilter } from './transactions.js';
import { localDay } from './sync.js';

const { transaction, category, categoryGroup, householdSettings, financialAccount } = schema;

// Read-only analytics over booked, non-transfer rows in the household currency. A transfer is a
// row with a transfer group or in the transfer category (`notTransferFilter`); pending rows and
// other-currency rows never enter a sum (other-currency rows are counted as `foreignCount`).
// Sums run in SQL as bigint and come back as text; a value outside the safe range is rejected.

const MAX_RANGE_MONTHS = 120;

const monthOf = (date: string): string => date.slice(0, 7);

function addMonths(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function lastDayOf(month: string): string {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return `${month}-${String(last.getUTCDate()).padStart(2, '0')}`;
}

/** Every `yyyy-mm` from the month of `from` to the month of `to`, inclusive. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

const rangeSchema = z
  .strictObject({ from: calendarDate, to: calendarDate })
  .refine((r) => r.from <= r.to, 'from must not be after to')
  .refine(
    (r) => monthsBetween(r.from, r.to).length <= MAX_RANGE_MONTHS,
    `range is limited to ${MAX_RANGE_MONTHS} months`,
  );

type Settings = {
  currency: string;
  timezone: string;
  hubAccountId: string | null;
  transferCategoryId: string | undefined;
};

async function loadSettings(tx: Tx, householdId: string): Promise<Settings> {
  const [row] = await tx
    .select({
      currency: householdSettings.currency,
      timezone: householdSettings.timezone,
      hubAccountId: householdSettings.hubAccountId,
    })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  if (!row) throw new NotFoundError('Household settings');
  return { ...row, transferCategoryId: await findTransferCategory(tx, householdId) };
}

const sumText = (expr: ReturnType<typeof sql>) => sql<string>`coalesce(${expr}, 0)::text`;

// ---------------------------------------------------------------------------------------------
// Spending by group

export type SpendingCategory = { categoryId: string | null; name: string; amount: number };
export type SpendingGroup = {
  groupId: string;
  name: string;
  amount: number;
  /** Share of `total` in basis points; with `uncategorised` the shares add up to 10000. */
  share_bps: number;
  categories: SpendingCategory[];
};
export type SpendingByGroup = {
  currency: string;
  /** Grouped spending plus `uncategorised`. */
  total: number;
  groups: SpendingGroup[];
  uncategorised: number;
  /** Booked non-transfer rows in another currency, left out of every amount. */
  foreignCount: number;
};

/**
 * Spending (expense outflows, positive) over [from, to] by category group. Refunds net within
 * their category and a category clamps at zero, so a refund larger than the spend never turns
 * into negative spending. Categories of income and saving groups do not count as spending.
 */
export async function spendingByGroup(
  ctx: ServiceCtx,
  rawRange: { from: string; to: string },
): Promise<SpendingByGroup> {
  const range = parseInput(rangeSchema, rawRange);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const settings = await loadSettings(tx, ctx.householdId);
    const base = and(
      eq(transaction.householdId, ctx.householdId),
      eq(transaction.status, 'booked'),
      gte(transaction.purchaseDate, range.from),
      lte(transaction.purchaseDate, range.to),
      notTransferFilter(settings.transferCategoryId),
    );
    const own = and(base, eq(transaction.currency, settings.currency));

    const perCategory = await tx
      .select({
        categoryId: category.id,
        categoryName: category.name,
        groupId: categoryGroup.id,
        groupName: categoryGroup.name,
        net: sumText(sql`-sum(${transaction.amount})`),
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
      .where(and(own, eq(categoryGroup.kind, 'expense')))
      .groupBy(category.id, category.name, categoryGroup.id, categoryGroup.name);

    const [uncat] = await tx
      .select({
        // Outflows only: an uncategorised inflow is not a refund of anything.
        net: sumText(sql`-sum(${transaction.amount}) filter (where ${transaction.amount} < 0)`),
      })
      .from(transaction)
      .where(and(own, sql`${transaction.categoryId} is null`));
    const [foreign] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(and(base, ne(transaction.currency, settings.currency)));

    const groups = new Map<string, SpendingGroup>();
    for (const r of perCategory) {
      const amount = Math.max(0, toSafeNumber(r.net));
      if (amount === 0) continue;
      const g = groups.get(r.groupId) ?? {
        groupId: r.groupId,
        name: r.groupName,
        amount: 0,
        share_bps: 0,
        categories: [],
      };
      g.amount += amount;
      g.categories.push({ categoryId: r.categoryId, name: r.categoryName, amount });
      groups.set(r.groupId, g);
    }
    const byAmount = <T extends { amount: number; name: string }>(a: T, b: T) =>
      b.amount - a.amount || a.name.localeCompare(b.name);
    const sorted = [...groups.values()].sort(byAmount);
    for (const g of sorted) g.categories.sort(byAmount);

    const uncategorised = toSafeNumber(uncat?.net ?? '0');
    const total = sorted.reduce((a, g) => a + g.amount, 0) + uncategorised;
    if (!Number.isSafeInteger(total))
      throw new RangeError(`Amount is not a safe integer: ${total}`);
    if (total > 0) {
      const shares = splitByWeights(10_000, [...sorted.map((g) => g.amount), uncategorised]);
      sorted.forEach((g, i) => {
        g.share_bps = shares[i]!;
      });
    }
    return {
      currency: settings.currency,
      total,
      groups: sorted,
      uncategorised,
      foreignCount: foreign?.n ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Income and expense: the one definition

export type FlowRow = {
  /** The bucket key (a month `yyyy-mm`, or '' for the whole range). */
  bucket: string;
  currency: string;
  income: number;
  expense: number;
  /** Rows counted, and of those the ones without a category. */
  count: number;
  uncategorised: number;
};

/**
 * Income and expense of booked, non-transfer rows per (bucket, currency), the one definition
 * behind the home summary, the monthly trends and the AI fact sheet. Expense is the net outflow
 * of expense-kind categories (refunds net out, a category clamps at zero) plus uncategorised
 * outflows, as in `spendingByGroup`; income is the net of income-kind categories plus
 * uncategorised inflows. Saving-kind categories count as neither. `bucket` is a SQL expression
 * over `transaction` (a month, or a constant for the whole range).
 */
export async function incomeExpenseRows(
  tx: Tx,
  p: {
    householdId: string;
    from: string;
    to: string;
    transferCategoryId: string | undefined;
    /** Only this currency; every currency when omitted. */
    currency?: string;
    bucket: ReturnType<typeof sql>;
  },
): Promise<FlowRow[]> {
  const res = await tx.execute<{
    bucket: string;
    currency: string;
    income: string;
    expense: string;
    count: number;
    uncategorised: number;
  }>(sql`
    select bucket, currency,
      (coalesce(sum(greatest(net, 0)) filter (where kind = 'income'), 0)
        + coalesce(sum(ins) filter (where category_id is null), 0))::text as income,
      (coalesce(sum(greatest(-net, 0)) filter (where kind = 'expense'), 0)
        + coalesce(sum(-outs) filter (where category_id is null), 0))::text as expense,
      sum(n)::int as count,
      (coalesce(sum(n) filter (where category_id is null), 0))::int as uncategorised
    from (
      select ${p.bucket} as bucket, ${transaction.currency} as currency,
        ${transaction.categoryId} as category_id, ${categoryGroup.kind} as kind,
        sum(${transaction.amount}) as net,
        sum(${transaction.amount}) filter (where ${transaction.amount} < 0) as outs,
        sum(${transaction.amount}) filter (where ${transaction.amount} > 0) as ins,
        count(*) as n
      from ${transaction}
      left join ${category}
        on ${category.id} = ${transaction.categoryId}
       and ${category.householdId} = ${transaction.householdId}
      left join ${categoryGroup}
        on ${categoryGroup.id} = ${category.groupId}
       and ${categoryGroup.householdId} = ${category.householdId}
      where ${and(
        eq(transaction.householdId, p.householdId),
        eq(transaction.status, 'booked'),
        gte(transaction.purchaseDate, p.from),
        lte(transaction.purchaseDate, p.to),
        notTransferFilter(p.transferCategoryId),
        p.currency === undefined ? undefined : eq(transaction.currency, p.currency),
      )}
      group by 1, 2, 3, 4
    ) per
    group by bucket, currency
    order by bucket, currency`);
  const rows = res.rows ?? (res as unknown as Array<(typeof res.rows)[number]>);
  return rows.map((r) => ({
    bucket: r.bucket,
    currency: r.currency,
    income: toSafeNumber(r.income),
    expense: toSafeNumber(r.expense),
    count: r.count,
    uncategorised: r.uncategorised,
  }));
}

// ---------------------------------------------------------------------------------------------
// Monthly trends

export type MonthlyTrend = {
  month: string;
  income: number;
  expense: number;
  /** Net flow (all rows) on the accounts of saving budget lines; 0 without a budget. */
  saving: number;
  /** income - expense. */
  net: number;
};

const trendsSchema = z.strictObject({
  months: z.number().int().min(1).max(36),
  endMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM')
    .optional(),
});

/**
 * Income, expense, saving and net for each of the last `months` calendar months ending at
 * `endMonth` (default: the current month in the household timezone, from `now`). Every month is
 * present, zero-filled.
 */
export async function monthlyTrends(
  ctx: ServiceCtx,
  rawInput: { months: number; endMonth?: string },
  now: Date = new Date(),
): Promise<MonthlyTrend[]> {
  const input = parseInput(trendsSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const settings = await loadSettings(tx, ctx.householdId);
    if (!isValidTimezone(settings.timezone)) {
      throw new ValidationError(
        `Unknown household timezone: ${settings.timezone}`,
        [],
        'invalid_timezone',
      );
    }
    const end = input.endMonth ?? monthOf(localDay(now, settings.timezone));
    const start = addMonths(end, 1 - input.months);
    const from = `${start}-01`;
    const to = lastDayOf(end);

    const rows = await incomeExpenseRows(tx, {
      householdId: ctx.householdId,
      from,
      to,
      transferCategoryId: settings.transferCategoryId,
      currency: settings.currency,
      bucket: sql`to_char(${transaction.purchaseDate}, 'YYYY-MM')`,
    });
    const saving = await savingFlowByMonthInTx(tx, {
      householdId: ctx.householdId,
      from,
      to,
      currency: settings.currency,
      hubAccountId: settings.hubAccountId,
    });

    const byMonth = new Map(rows.map((r) => [r.bucket, r]));
    return monthsBetween(from, to).map((month) => {
      const r = byMonth.get(month);
      const income = r?.income ?? 0;
      const expense = r?.expense ?? 0;
      return { month, income, expense, saving: saving.get(month) ?? 0, net: income - expense };
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Cash flow

export type CashFlow = {
  inflow: number;
  /** Positive. */
  outflow: number;
  net: number;
  byMonth: Array<{ month: string; inflow: number; outflow: number; net: number }>;
  byAccount: Array<{ accountId: string; inflow: number; outflow: number }>;
  /** Booked non-transfer rows in another currency, left out of every amount. */
  foreignCount: number;
};

const cashFlowSchema = z
  .strictObject({
    from: calendarDate,
    to: calendarDate,
    accountIds: z.array(z.uuid()).max(500).optional(),
  })
  .refine((r) => r.from <= r.to, 'from must not be after to')
  .refine(
    (r) => monthsBetween(r.from, r.to).length <= MAX_RANGE_MONTHS,
    `range is limited to ${MAX_RANGE_MONTHS} months`,
  );

/**
 * Money in and out over [from, to], optionally for some accounts only. Transfers between
 * household accounts are left out, so moving money around never shows up as flow.
 */
export async function cashFlow(
  ctx: ServiceCtx,
  rawInput: { from: string; to: string; accountIds?: string[] },
): Promise<CashFlow> {
  const input = parseInput(cashFlowSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const settings = await loadSettings(tx, ctx.householdId);
    const base = and(
      eq(transaction.householdId, ctx.householdId),
      eq(transaction.status, 'booked'),
      gte(transaction.purchaseDate, input.from),
      lte(transaction.purchaseDate, input.to),
      notTransferFilter(settings.transferCategoryId),
      input.accountIds ? inArray(transaction.accountId, input.accountIds) : undefined,
    );
    const own = and(base, eq(transaction.currency, settings.currency));
    const inflow = sumText(
      sql`sum(${transaction.amount}) filter (where ${transaction.amount} > 0)`,
    );
    const outflow = sumText(
      sql`-sum(${transaction.amount}) filter (where ${transaction.amount} < 0)`,
    );

    const monthExpr = sql<string>`to_char(${transaction.purchaseDate}, 'YYYY-MM')`;
    const months = await tx
      .select({ month: monthExpr, inflow, outflow })
      .from(transaction)
      .where(own)
      .groupBy(monthExpr);
    const accounts = await tx
      .select({ accountId: transaction.accountId, inflow, outflow })
      .from(transaction)
      .where(own)
      .groupBy(transaction.accountId);
    const names = new Map(
      (
        await tx
          .select({ id: financialAccount.id, name: financialAccount.name })
          .from(financialAccount)
          .where(eq(financialAccount.householdId, ctx.householdId))
      ).map((a) => [a.id, a.name]),
    );
    const [foreign] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(and(base, ne(transaction.currency, settings.currency)));

    const monthRows = new Map(months.map((r) => [r.month, r]));
    const byMonth = monthsBetween(input.from, input.to).map((month) => {
      const r = monthRows.get(month);
      const i = toSafeNumber(r?.inflow ?? '0');
      const o = toSafeNumber(r?.outflow ?? '0');
      return { month, inflow: i, outflow: o, net: i - o };
    });
    const totalIn = byMonth.reduce((a, m) => a + m.inflow, 0);
    const totalOut = byMonth.reduce((a, m) => a + m.outflow, 0);
    if (!Number.isSafeInteger(totalIn) || !Number.isSafeInteger(totalOut)) {
      throw new RangeError('Amount is not a safe integer');
    }
    return {
      inflow: totalIn,
      outflow: totalOut,
      net: totalIn - totalOut,
      byMonth,
      byAccount: accounts
        .map((r) => ({
          accountId: r.accountId,
          inflow: toSafeNumber(r.inflow),
          outflow: toSafeNumber(r.outflow),
        }))
        .sort(
          (a, b) =>
            b.outflow - a.outflow ||
            (names.get(a.accountId) ?? '').localeCompare(names.get(b.accountId) ?? '') ||
            a.accountId.localeCompare(b.accountId),
        ),
      foreignCount: foreign?.n ?? 0,
    };
  });
}
