import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import type { ServiceCtx } from '../context.js';
import { monthlyTrends, spendingByGroup } from '../analytics.js';
import { budgetMonthView, listBudgets } from '../budgets.js';
import { householdToday } from '../net-worth.js';
import { recurringMonthlyCost } from '../recurring.js';
import {
  completeMonths,
  TYPICAL_WINDOW_MONTHS,
  typicalSpend,
  type SpendingProfile,
  type TypicalSpend,
} from './profile.js';

const { transaction, financialAccount, budgetLine } = schema;

const monthIndex = (month: string): number =>
  Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);

function lastDayOf(month: string): string {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return `${month}-${String(last.getUTCDate()).padStart(2, '0')}`;
}

/** `typical` once at least `required` months carry data; zero-filled months still count in it. */
function typicalOrNull(values: number[], required: number): TypicalSpend | null {
  return values.filter((v) => v > 0).length >= required ? typicalSpend(values) : null;
}

/**
 * The advisor's one source of numbers: what a normal month looks like per category, income and
 * budget line over the last (up to) six complete months, once the household has at least
 * `learningMonths` complete months of booked data. Spending and income reuse the analytics
 * (booked rows, transfers out, household currency); budget lines come from the household's
 * latest active budget through `budgetMonthView`, expense lines only. Amounts are positive
 * minor units.
 */
export async function loadSpendingProfile(
  ctx: ServiceCtx,
  opts: { learningMonths: number; today?: string },
): Promise<SpendingProfile> {
  const required = opts.learningMonths;
  const clock = await householdToday(ctx);
  const today = opts.today ?? clock.today;

  // Purchase date, as in the analytics: it decides which month a row belongs to.
  const [first] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ firstOn: sql<string | null>`min(${transaction.purchaseDate})::text` })
      .from(transaction)
      .innerJoin(
        financialAccount,
        and(
          eq(financialAccount.id, transaction.accountId),
          eq(financialAccount.householdId, transaction.householdId),
        ),
      )
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.status, 'booked'),
          isNull(financialAccount.archivedAt),
        ),
      ),
  );
  const months = completeMonths(first?.firstOn ?? null, today);
  const window = months.slice(-TYPICAL_WINDOW_MONTHS);
  const ready = months.length >= required;

  const recurring = await recurringMonthlyCost(ctx);
  const profile: SpendingProfile = {
    learning: { ready, completeMonths: months.length, required },
    currency: clock.currency,
    window,
    categories: [],
    income: null,
    recurringMonthly: recurring.amount,
    budgetLines: [],
  };
  if (window.length === 0) return profile;

  // Categories: one spending breakdown per month, zero-filled where a category did not appear.
  const perCategory = new Map<
    string,
    { name: string; group: string; values: number[]; total: number }
  >();
  for (const [i, month] of window.entries()) {
    const spend = await spendingByGroup(ctx, { from: `${month}-01`, to: lastDayOf(month) });
    for (const g of spend.groups) {
      for (const c of g.categories) {
        if (c.categoryId === null) continue;
        const row = perCategory.get(c.categoryId) ?? {
          name: c.name,
          group: g.name,
          values: window.map(() => 0),
          total: 0,
        };
        row.values[i] = c.amount;
        row.total += c.amount;
        perCategory.set(c.categoryId, row);
      }
    }
  }
  profile.categories = [...perCategory.entries()]
    .sort(([, a], [, b]) => b.total - a.total || a.name.localeCompare(b.name))
    .map(([categoryId, r]) => ({
      categoryId,
      name: r.name,
      group: r.group,
      typical: ready ? typicalOrNull(r.values, required) : null,
    }));

  if (ready) {
    const trends = await monthlyTrends(ctx, {
      months: window.length,
      endMonth: window[window.length - 1]!,
    });
    profile.income = typicalOrNull(
      trends.map((m) => m.income),
      required,
    );
  }

  profile.budgetLines = await loadBudgetLines(ctx, window, ready ? required : null);
  return profile;
}

/** Expense lines of the latest active budget; `required` null skips the actuals. */
async function loadBudgetLines(
  ctx: ServiceCtx,
  window: string[],
  required: number | null,
): Promise<SpendingProfile['budgetLines']> {
  const current = (await listBudgets(ctx)).find((b) => b.status === 'active');
  if (!current) return [];
  const lines = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ id: budgetLine.id, name: budgetLine.name, updatedAt: budgetLine.updatedAt })
      .from(budgetLine)
      .where(
        and(
          eq(budgetLine.householdId, ctx.householdId),
          eq(budgetLine.budgetId, current.id),
          eq(budgetLine.kind, 'expense'),
        ),
      )
      .orderBy(asc(budgetLine.position), asc(budgetLine.createdAt), asc(budgetLine.name)),
  );

  // Window months inside the budget's 12-month year, as month indexes 1..12.
  const startIndex = monthIndex(current.startMonth.slice(0, 7));
  const actuals = new Map<string, number[]>(lines.map((l) => [l.id, []]));
  if (required !== null) {
    for (const month of window) {
      const index = monthIndex(month) - startIndex + 1;
      if (index < 1 || index > 12) continue;
      const view = await budgetMonthView(ctx, current.id, index);
      for (const l of view.lines) actuals.get(l.lineId)?.push(l.actual);
    }
  }
  return lines.map((l) => ({
    lineId: l.id,
    name: l.name,
    typical: required === null ? null : typicalOrNull(actuals.get(l.id) ?? [], required),
    updatedAt: l.updatedAt.toISOString(),
  }));
}
