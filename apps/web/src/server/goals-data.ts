import {
  budgetYearView,
  emergencyFundAverage,
  getBudgetLine,
  listAccounts,
  listGoals,
  NotFoundError,
  type GoalView,
  type ServiceCtx,
} from '@arfolio/services';
import { notFound } from 'next/navigation';
import { todayIn } from '../lib/dates';
import { assertValidId } from '../lib/ids';
import { orderGoals, totalSaved } from '../lib/goals';
import { resolveBudget } from './budget-data';
import { loadHouseholdFormat } from './household-format';
import { toAccountDto } from './serialize';

export interface GoalDto {
  id: string;
  kind: 'generic' | 'emergency_fund';
  name: string;
  target: number | null;
  saved: number;
  contribution: number;
  targetDate: string | null;
  remaining: number;
  months: number | null;
  expectedDate: string | null;
  progressBps: number | null;
  accountName: string | null;
  lineName: string | null;
}

export type GoalsPageData = {
  today: string;
  currency: string;
  goals: GoalDto[];
  totalSaved: number;
  hasEmergencyFund: boolean;
  /** `household_settings.emergency_fund_months`: the multiplier of the derived target. */
  emergencyFundMonths: number;
};

/** The name of the budget line a goal is linked to; a line that no longer exists says nothing. */
async function lineNameOf(ctx: ServiceCtx, id: string | null): Promise<string | null> {
  if (!id) return null;
  try {
    return (await getBudgetLine(ctx, id)).name;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** Everything the Objetivos page renders: each goal with its progress, projection and source. */
export async function loadGoalsPage(
  ctx: ServiceCtx,
  emergencyFundMonths: number,
): Promise<GoalsPageData> {
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const [goals, accounts] = await Promise.all([
    listGoals(ctx),
    listAccounts(ctx, { includeArchived: true }),
  ]);
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const lineNames = new Map(
    await Promise.all(
      [...new Set(goals.flatMap((g) => (g.budgetLineId ? [g.budgetLineId] : [])))].map(
        async (id) => [id, await lineNameOf(ctx, id)] as const,
      ),
    ),
  );
  const dtos = orderGoals(
    goals.map((g): GoalDto => ({
      id: g.id,
      kind: g.kind,
      name: g.name,
      target: g.target,
      saved: g.saved,
      contribution: g.contribution,
      targetDate: g.targetDate,
      remaining: g.projection.remaining,
      months: g.projection.months,
      expectedDate: g.projection.expectedDate,
      progressBps: g.projection.progressBps,
      accountName: g.accountId ? (accountNames.get(g.accountId) ?? null) : null,
      lineName: g.budgetLineId ? (lineNames.get(g.budgetLineId) ?? null) : null,
    })),
  );
  return {
    today: todayIn(timeZone),
    currency,
    goals: dtos,
    totalSaved: totalSaved(dtos),
    hasEmergencyFund: dtos.some((g) => g.kind === 'emergency_fund'),
    emergencyFundMonths,
  };
}

export interface SavingLineOption {
  id: string;
  name: string;
  /** What the line plans for this month, minor units. */
  planned: number;
}

export interface GoalFormData {
  today: string;
  currency: string;
  accounts: Array<{ id: string; name: string }>;
  savingLines: SavingLineOption[];
  /** Another live goal is already the household's emergency fund. */
  otherEmergencyFund: boolean;
  emergency: {
    months: number;
    /** The current budget's average planned monthly expense; null without a current budget. */
    average: number | null;
  };
  goal: {
    id: string;
    kind: 'generic' | 'emergency_fund';
    name: string;
    targetAmount: number | null;
    targetDate: string | null;
    accountId: string | null;
    budgetLineId: string | null;
    monthlyContribution: number | null;
    savedBaseline: number | null;
    savedBaselineDate: string | null;
  } | null;
}

/** What the goal form needs: the choices for "where the money is" and the emergency-fund facts. */
export async function loadGoalForm(
  ctx: ServiceCtx,
  id: string | null,
  emergencyFundMonths: number,
): Promise<GoalFormData> {
  if (id) assertValidId(id);
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const [goals, accounts, resolved] = await Promise.all([
    listGoals(ctx),
    listAccounts(ctx, { includeArchived: true }),
    resolveBudget(ctx, {}),
  ]);
  const found: GoalView | null = id ? (goals.find((g) => g.id === id) ?? null) : null;
  if (id && !found) notFound();

  let savingLines: SavingLineOption[] = [];
  if (resolved.kind === 'ready') {
    const view = await budgetYearView(ctx, resolved.budget.id);
    savingLines = view.lines
      .filter((l) => l.kind === 'saving')
      .map((l) => ({
        id: l.lineId,
        name: l.name,
        planned: l.months[resolved.monthIndex - 1]?.planned ?? 0,
      }));
  }
  // A goal linked to a line of another budget keeps showing it as the current choice.
  if (found?.budgetLineId && !savingLines.some((l) => l.id === found.budgetLineId)) {
    const name = await lineNameOf(ctx, found.budgetLineId);
    if (name) savingLines = [...savingLines, { id: found.budgetLineId, name, planned: 0 }];
  }

  return {
    today: todayIn(timeZone),
    currency,
    accounts: accounts
      .map(toAccountDto)
      // A credit card saves nothing, so it is not offered (a goal already on one keeps it).
      .filter((a) => (!a.archived && a.type !== 'card') || a.id === found?.accountId)
      .map((a) => ({ id: a.id, name: a.name })),
    savingLines,
    otherEmergencyFund: goals.some((g) => g.kind === 'emergency_fund' && g.id !== id),
    // From the goals service's own choice of current budget, so the form and the card agree.
    emergency: { months: emergencyFundMonths, average: await emergencyFundAverage(ctx) },
    goal: found && {
      id: found.id,
      kind: found.kind,
      name: found.name,
      targetAmount: found.targetAmount,
      targetDate: found.targetDate,
      accountId: found.accountId,
      budgetLineId: found.budgetLineId,
      monthlyContribution: found.monthlyContribution,
      savedBaseline: found.savedBaseline,
      savedBaselineDate: found.savedBaselineDate,
    },
  };
}
