import {
  budgetMonthView,
  budgetYearView,
  getBudget,
  getBudgetLine,
  listAccountBuckets,
  NotFoundError,
  listBudgets,
  listRecurring,
  transferPlan,
  unbudgetedSpending,
  type Budget,
  type BudgetMonthView,
  type BudgetYearView,
  type ServiceCtx,
  type TransferPlanView,
  type UnbudgetedRow,
} from '@arfolio/services';
import {
  defaultMonth,
  monthIndexIn,
  monthState,
  paceFraction,
  parseMonthParam,
  pickBudget,
  type BudgetRef,
  type MonthState,
} from '../lib/budget-period';
import { unbudgetedTotal } from '../lib/budget-status';
import { monthStart, todayIn } from '../lib/dates';
import type { RecurringDto } from '../lib/recurring-display';
import { loadHouseholdFormat } from './household-format';
import { loadLookups, type Lookups } from './lookups';

export type BudgetDto = BudgetRef;

export function toBudgetDto(b: Budget): BudgetDto {
  return { id: b.id, startMonth: b.startMonth, name: b.name, status: b.status };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A line as the month view needs it beyond its numbers: what it counts and where it belongs. */
export interface LineInfoDto {
  id: string;
  kind: 'income' | 'expense' | 'saving';
  name: string;
  groupId: string | null;
  accountId: string | null;
  categoryIds: string[];
  bucketIds: string[];
  position: number;
}

export type Resolution =
  | { kind: 'none'; budgets: BudgetDto[]; month: string }
  | { kind: 'uncovered'; budgets: BudgetDto[]; month: string }
  | {
      kind: 'ready';
      budgets: BudgetDto[];
      budget: BudgetDto;
      month: string;
      monthIndex: number;
      state: MonthState;
      today: string;
      pinned: boolean;
    };

type Query = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/** Which budget and month a page (`?month=yyyy-mm&budget=<id>`) is about. */
export async function resolveBudget(ctx: ServiceCtx, query: Query): Promise<Resolution> {
  const [{ timeZone }, rows] = await Promise.all([loadHouseholdFormat(ctx), listBudgets(ctx)]);
  const budgets = rows.map(toBudgetDto);
  const today = todayIn(timeZone);
  const todayMonth = monthStart(today);
  const pinnedParam = first(query.budget);
  const pinned =
    pinnedParam && UUID.test(pinnedParam)
      ? (budgets.find((b) => b.id === pinnedParam) ?? null)
      : null;
  const requested = parseMonthParam(first(query.month));

  if (pinned) {
    const month =
      requested && monthIndexIn(pinned, requested) !== null
        ? requested
        : defaultMonth(pinned, today);
    return {
      kind: 'ready',
      budgets,
      budget: pinned,
      month,
      monthIndex: monthIndexIn(pinned, month)!,
      state: monthState(month, todayMonth),
      today,
      pinned: true,
    };
  }

  const month = requested ?? todayMonth;
  if (budgets.length === 0) return { kind: 'none', budgets, month };
  const budget = pickBudget(budgets, month);
  if (!budget) return { kind: 'uncovered', budgets, month };
  return {
    kind: 'ready',
    budgets,
    budget,
    month,
    monthIndex: monthIndexIn(budget, month)!,
    state: monthState(month, todayMonth),
    today,
    pinned: false,
  };
}

/** The "Transferir X para n contas" line of the month view, from the transfer plan. */
export interface PlanSummaryDto {
  configured: boolean;
  hubName: string | null;
  /** Sum of what moves out of the hub. */
  total: number;
  accounts: number;
  remainingInHub: number;
  negative: boolean;
}

export function summarisePlan(plan: TransferPlanView, lookups: Lookups): PlanSummaryDto {
  if (!plan.configured) {
    return {
      configured: false,
      hubName: null,
      total: 0,
      accounts: 0,
      remainingInHub: 0,
      negative: false,
    };
  }
  const moving = plan.perAccount.filter((p) => p.amount > 0);
  return {
    configured: true,
    hubName: lookups.accounts.find((a) => a.id === plan.hubAccountId)?.name ?? null,
    total: moving.reduce((sum, p) => sum + p.amount, 0),
    accounts: moving.length,
    remainingInHub: plan.remainingInHub,
    negative: plan.negative,
  };
}

export interface MonthPageData {
  view: BudgetMonthView;
  lines: LineInfoDto[];
  unbudgeted: UnbudgetedRow[];
  plan: PlanSummaryDto;
  lookups: Lookups;
  pace: number | null;
}

/** Everything the month view renders for a resolved budget and month. */
export async function loadMonthPage(
  ctx: ServiceCtx,
  r: Extract<Resolution, { kind: 'ready' }>,
): Promise<MonthPageData> {
  const [view, detail, unbudgeted, plan, lookups] = await Promise.all([
    budgetMonthView(ctx, r.budget.id, r.monthIndex),
    getBudget(ctx, r.budget.id),
    unbudgetedSpending(ctx, r.budget.id, r.monthIndex),
    transferPlan(ctx, r.budget.id, r.monthIndex),
    loadLookups(ctx),
  ]);
  return {
    view,
    lines: detail.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      name: l.name,
      groupId: l.groupId,
      accountId: l.accountId,
      categoryIds: l.categoryIds,
      bucketIds: l.bucketIds,
      position: l.position,
    })),
    unbudgeted,
    plan: summarisePlan(plan, lookups),
    lookups,
    pace: paceFraction(r.today, r.month),
  };
}

export function toRecurringDto(r: Awaited<ReturnType<typeof listRecurring>>[number]): RecurringDto {
  return {
    id: r.id,
    name: r.name,
    amount: r.amount,
    currency: r.currency,
    cadence: r.cadence,
    status: r.status,
    source: r.source,
    accountId: r.accountId,
    categoryId: r.categoryId,
    budgetLineId: r.budgetLineId,
    nextExpectedOn: r.nextExpectedOn,
    lastSeenOn: r.lastSeenOn,
  };
}

export type YearResolution =
  | { kind: 'none' }
  | {
      kind: 'ready';
      budgets: BudgetDto[];
      budget: BudgetDto;
      todayMonth: string;
      pinned: boolean;
    };

/**
 * The budget of the year grid: `?start=yyyy-mm` (its start month) or `?budget=<id>`, else the
 * one covering today, else the latest active one.
 */
export async function resolveYearBudget(ctx: ServiceCtx, query: Query): Promise<YearResolution> {
  const [{ timeZone }, rows] = await Promise.all([loadHouseholdFormat(ctx), listBudgets(ctx)]);
  const budgets = rows.map(toBudgetDto);
  if (budgets.length === 0) return { kind: 'none' };
  const todayMonth = monthStart(todayIn(timeZone));
  const start = parseMonthParam(first(query.start));
  const idParam = first(query.budget);
  const chosen =
    (start ? budgets.find((b) => b.startMonth === start) : undefined) ??
    (idParam && UUID.test(idParam) ? budgets.find((b) => b.id === idParam) : undefined);
  if (chosen) return { kind: 'ready', budgets, budget: chosen, todayMonth, pinned: true };
  const active = budgets.filter((b) => b.status === 'active');
  const budget =
    pickBudget(budgets, todayMonth) ??
    active.sort((a, b) => b.startMonth.localeCompare(a.startMonth))[0];
  if (!budget) return { kind: 'none' };
  return { kind: 'ready', budgets, budget, todayMonth, pinned: false };
}

export interface YearPageData {
  view: BudgetYearView;
  lookups: Lookups;
}

export async function loadYearPage(ctx: ServiceCtx, budgetId: string): Promise<YearPageData> {
  const [view, lookups] = await Promise.all([budgetYearView(ctx, budgetId), loadLookups(ctx)]);
  return { view, lookups };
}

export interface EditableLineDto {
  id: string;
  name: string;
  kind: 'income' | 'expense' | 'saving';
  groupId: string | null;
  accountId: string | null;
  categoryIds: string[];
  /** Pies of the line's account it counts (saving lines on an investment account). */
  bucketIds: string[];
  amounts: number[];
  notes: string | null;
}

export interface BucketOption {
  id: string;
  name: string;
  removed: boolean;
}

export type LineEditorData =
  | { kind: 'missing' }
  | {
      kind: 'ready';
      budget: BudgetDto;
      line: EditableLineDto | null;
      /** The other lines of the budget: which categories they already count. */
      others: Array<{
        id: string;
        name: string;
        kind: 'income' | 'expense' | 'saving';
        accountId: string | null;
        categoryIds: string[];
        bucketIds: string[];
      }>;
      /** The pies of each investment account, by account id. */
      bucketsByAccount: Record<string, BucketOption[]>;
      lookups: Lookups;
    };

/**
 * What the line editor needs: for an existing line, the line and its budget; for a new one,
 * the budget it is added to (the one in `?budget=`, else the one covering today).
 */
export async function loadLineEditor(
  ctx: ServiceCtx,
  target: { lineId: string } | { budgetId: string | null },
): Promise<LineEditorData> {
  let budgetId: string | null;
  if ('lineId' in target) {
    if (!UUID.test(target.lineId)) return { kind: 'missing' };
    const found = await getBudgetLine(ctx, target.lineId).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (!found) return { kind: 'missing' };
    budgetId = found.budgetId;
  } else {
    budgetId = target.budgetId && UUID.test(target.budgetId) ? target.budgetId : null;
    if (!budgetId) {
      const [{ timeZone }, rows] = await Promise.all([loadHouseholdFormat(ctx), listBudgets(ctx)]);
      const budgets = rows.map(toBudgetDto);
      budgetId = pickBudget(budgets, monthStart(todayIn(timeZone)))?.id ?? budgets[0]?.id ?? null;
    }
    if (!budgetId) return { kind: 'missing' };
  }
  const [detail, lookups] = await Promise.all([getBudget(ctx, budgetId), loadLookups(ctx)]);
  const mine = 'lineId' in target ? detail.lines.find((l) => l.id === target.lineId) : undefined;
  if ('lineId' in target && !mine) return { kind: 'missing' };
  // One query per investment account: the pies a saving line can count.
  const investment = lookups.accounts.filter((a) => a.type === 'investment' && !a.archived);
  const held = await Promise.all(investment.map((a) => listAccountBuckets(ctx, a.id)));
  const bucketsByAccount: Record<string, BucketOption[]> = {};
  investment.forEach((a, i) => {
    bucketsByAccount[a.id] = held[i]!;
  });
  return {
    kind: 'ready',
    budget: toBudgetDto(detail),
    line: mine
      ? {
          id: mine.id,
          name: mine.name,
          kind: mine.kind,
          groupId: mine.groupId,
          accountId: mine.accountId,
          categoryIds: mine.categoryIds,
          bucketIds: mine.bucketIds,
          amounts: mine.amounts,
          notes: mine.notes,
        }
      : null,
    others: detail.lines
      .filter((l) => l.id !== mine?.id)
      .map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        accountId: l.accountId,
        categoryIds: l.categoryIds,
        bucketIds: l.bucketIds,
      })),
    bucketsByAccount,
    lookups,
  };
}

export type HomeBudget =
  | { kind: 'none' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      budget: BudgetDto;
      month: string;
      view: BudgetMonthView;
      pace: number | null;
      /** Booked spending outside the budget this month, household currency. */
      unbudgeted: number;
    };

/** The budget of today's month for the home card; a failure is reported, never thrown. */
export async function loadHomeBudget(ctx: ServiceCtx): Promise<HomeBudget> {
  try {
    const r = await resolveBudget(ctx, {});
    if (r.kind !== 'ready') return { kind: 'none' };
    const [view, unbudgeted] = await Promise.all([
      budgetMonthView(ctx, r.budget.id, r.monthIndex),
      unbudgetedSpending(ctx, r.budget.id, r.monthIndex),
    ]);
    return {
      kind: 'ready',
      budget: r.budget,
      month: r.month,
      view,
      pace: paceFraction(r.today, r.month),
      unbudgeted: unbudgetedTotal(unbudgeted),
    };
  } catch (error) {
    console.error(`home budget failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    return { kind: 'error' };
  }
}
