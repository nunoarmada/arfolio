import { z } from 'zod';
import { minorDecimal } from '@arfolio/core';
import { parseInput, type ServiceCtx } from '../context.js';
import { redactForAi } from '../ai/redact.js';
import { monthlyTrends, spendingByGroup, type MonthlyTrend } from '../analytics.js';
import { netWorthAt, netWorthHistory } from '../net-worth.js';
import { recurringMonthlyCost } from '../recurring.js';
import { detectAnomalies, type Anomaly } from './anomalies.js';
import { coveringBudgetView } from './budget-month.js';
import { addMonths, firstDay, lastDay, MONTH_INPUT, monthKey } from './month.js';

// The monthly fact sheet: the only thing the AI report model is given. It is built from the
// existing services (analytics, budgets, recurring, net worth) plus the anomaly rules, and holds
// aggregates only: category/group/budget-line names (through `redactForAi`) and amounts as decimal
// strings in the household currency. Transaction descriptions, notes, account names, IBANs and
// member names or emails are never read here. Other currencies are counted, not summed.

export const FACT_SHEET_VERSION = 1;
const BUDGET_LINE_LIMIT = 10;

export type FactTotals = { income: string; expense: string; saving: string; net: string };

export type FactSheet = {
  schemaVersion: typeof FACT_SHEET_VERSION;
  /** The reported month, `yyyy-mm`. */
  month: string;
  currency: string;
  totals: FactTotals;
  /** The month before. */
  previous: FactTotals;
  /** The average of the (up to) three months before the month that have any income or expense. */
  avg3: FactTotals;
  /** Spending by category group, biggest first; `budget` is null without a budget for the group. */
  groups: Array<{ name: string; actual: string; budget: string | null; prevActual: string }>;
  /** Expense lines of the budget covering the month, top 10 by absolute deviation. */
  budgetLines: Array<{ name: string; actual: string; planned: string }>;
  recurring: {
    monthlyCost: string;
    /** New recurring charges and price changes of the month (also in `anomalies`). */
    changes: Anomaly[];
  };
  /** Net worth at the end of the month, at the end of the month before, and the 12-month change. */
  netWorth: { now: string; monthStart: string; change12m: string | null };
  anomalies: Anomaly[];
  /** Booked non-transfer rows of the month in another currency, left out of every amount. */
  otherCurrencyCount: number;
};

const inputSchema = z.strictObject({ month: z.string().regex(MONTH_INPUT, 'expected YYYY-MM') });

/** Integer division rounding half away from zero. */
function divRound(n: bigint, d: bigint): bigint {
  const half = d / 2n;
  return n >= 0n ? (n + half) / d : -((-n + half) / d);
}

/**
 * The fact sheet of `month` (`yyyy-mm`, or the first day of it), read-only for any role. `now`
 * only decides which month net worth treats as still open (as in `netWorthHistory`).
 */
export async function buildFactSheet(
  ctx: ServiceCtx,
  rawInput: { month: string },
  now: Date = new Date(),
): Promise<FactSheet> {
  const month = monthKey(parseInput(inputSchema, rawInput).month);
  const prevMonth = addMonths(month, -1);
  const range = (m: string) => ({ from: firstDay(m), to: lastDay(m) });

  const trends = await monthlyTrends(ctx, { months: 4, endMonth: month }, now);
  const [spend, prevSpend, anomalies, cost, view] = await Promise.all([
    spendingByGroup(ctx, range(month)),
    spendingByGroup(ctx, range(prevMonth)),
    detectAnomalies(ctx, { month }),
    recurringMonthlyCost(ctx),
    coveringBudgetView(ctx, month),
  ]);
  const currency = spend.currency;
  const dec = (minor: number | bigint) => minorDecimal(minor, currency);

  const totals = (row: MonthlyTrend): FactTotals => ({
    income: dec(row.income),
    expense: dec(row.expense),
    saving: dec(row.saving),
    net: dec(row.net),
  });
  // Months without any income or expense (before the household had data) would drag the average
  // down, so it runs over the months that have some.
  const last3 = trends.slice(0, 3).filter((r) => r.income !== 0 || r.expense !== 0);
  const average = (pick: (r: MonthlyTrend) => number): bigint =>
    last3.length === 0
      ? 0n
      : divRound(
          last3.reduce((a, r) => a + BigInt(pick(r)), 0n),
          BigInt(last3.length),
        );

  const budgetOf = new Map(
    (view?.groups ?? []).filter((g) => g.kind === 'expense').map((g) => [g.groupId, g.planned]),
  );
  const prevActual = new Map(prevSpend.groups.map((g) => [g.groupId, g.amount]));
  const seen = new Set<string>();
  const groups = [...spend.groups, ...prevSpend.groups]
    .filter((g) => !seen.has(g.groupId) && seen.add(g.groupId))
    .map((g) => ({
      id: g.groupId,
      name: redactForAi(g.name),
      actual: spend.groups.find((s) => s.groupId === g.groupId)?.amount ?? 0,
      budget: budgetOf.get(g.groupId),
      prevActual: prevActual.get(g.groupId) ?? 0,
    }))
    .sort((a, b) => b.actual - a.actual || a.name.localeCompare(b.name))
    .map((g) => ({
      name: g.name,
      actual: dec(g.actual),
      budget: g.budget === undefined ? null : dec(g.budget),
      prevActual: dec(g.prevActual),
    }));

  const abs = (n: bigint) => (n < 0n ? -n : n);
  const budgetLines = (view?.lines ?? [])
    .filter((l) => l.kind === 'expense' && (l.actual !== 0 || l.planned !== 0))
    .map((l) => ({ l, deviation: abs(BigInt(l.actual) - BigInt(l.planned)) }))
    .sort((a, b) =>
      a.deviation === b.deviation
        ? a.l.name.localeCompare(b.l.name)
        : a.deviation > b.deviation
          ? -1
          : 1,
    )
    .slice(0, BUDGET_LINE_LIMIT)
    .map(({ l }) => ({
      name: redactForAi(l.name),
      actual: dec(l.actual),
      planned: dec(l.planned),
    }));

  // Net worth at the end of each month: a stored snapshot, or computed as of that day.
  const history = await netWorthHistory(
    ctx,
    { from: firstDay(addMonths(month, -12)), to: lastDay(month) },
    { now },
  );
  const at = new Map(history.map((h) => [h.month.slice(0, 7), h.net]));
  const endOf = async (m: string): Promise<number> =>
    at.get(m) ?? (await netWorthAt(ctx, lastDay(m))).net;
  const nowNet = await endOf(month);
  const startNet = await endOf(prevMonth);
  const yearAgo = at.get(addMonths(month, -12));

  return {
    schemaVersion: FACT_SHEET_VERSION,
    month,
    currency,
    totals: totals(trends[3]!),
    previous: totals(trends[2]!),
    avg3: {
      income: dec(average((r) => r.income)),
      expense: dec(average((r) => r.expense)),
      saving: dec(average((r) => r.saving)),
      net: dec(average((r) => r.net)),
    },
    groups,
    budgetLines,
    recurring: {
      monthlyCost: dec(cost.amount),
      changes: anomalies.filter(
        (a) => a.type === 'new_recurring' || a.type === 'recurring_price_change',
      ),
    },
    netWorth: {
      now: dec(nowNet),
      monthStart: dec(startNet),
      change12m: yearAgo === undefined ? null : dec(BigInt(nowNet) - BigInt(yearAgo)),
    },
    anomalies,
    otherCurrencyCount: spend.foreignCount,
  };
}

/** True when the month has any income or expense (transfers and other currencies do not count). */
export function hasActivity(facts: FactSheet): boolean {
  const nonZero = (decimal: string) => /[1-9]/.test(decimal);
  return nonZero(facts.totals.income) || nonZero(facts.totals.expense);
}
