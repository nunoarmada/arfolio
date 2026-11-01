import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { budgetMonths, emergencyFundTarget, projectGoal, type GoalProjection } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  budgetYearView,
  budgetYearViewInTx,
  isUniqueViolation,
  requireAccount,
  type BudgetYearView,
} from './budgets.js';
import {
  assertCanWrite,
  assertUuid,
  calendarDate,
  MAX_AMOUNT_MINOR,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { accountBalancesInTx, monthStart } from './net-worth.js';
import { localDay } from './sync.js';

const { goal, budget, budgetLine, householdSettings } = schema;

export type Goal = typeof goal.$inferSelect;

export type GoalView = Goal & {
  /** The target in force: for an emergency fund the one derived from the current budget. */
  target: number | null;
  saved: number;
  /** Monthly amount put aside: the explicit override, else the linked line's plan this month. */
  contribution: number;
  projection: GoalProjection;
};

const amount = z.number().int().min(0).max(MAX_AMOUNT_MINOR);
const goalFields = {
  kind: z.enum(schema.GOAL_KINDS),
  name: z.string().trim().min(1).max(120),
  targetAmount: amount.nullable(),
  targetDate: calendarDate.nullable(),
  accountId: z.string().nullable(),
  budgetLineId: z.string().nullable(),
  monthlyContribution: amount.nullable(),
  savedBaseline: amount.nullable(),
  savedBaselineDate: calendarDate.nullable(),
  position: z.number().int().min(0).max(32_767),
};

const createSchema = z.strictObject({
  kind: goalFields.kind.optional(),
  name: goalFields.name,
  targetAmount: goalFields.targetAmount.optional(),
  targetDate: goalFields.targetDate.optional(),
  accountId: goalFields.accountId.optional(),
  budgetLineId: goalFields.budgetLineId.optional(),
  monthlyContribution: goalFields.monthlyContribution.optional(),
  savedBaseline: goalFields.savedBaseline.optional(),
  savedBaselineDate: goalFields.savedBaselineDate.optional(),
  position: goalFields.position.optional(),
});

const patchSchema = z.strictObject({
  kind: goalFields.kind.optional(),
  name: goalFields.name.optional(),
  targetAmount: goalFields.targetAmount.optional(),
  targetDate: goalFields.targetDate.optional(),
  accountId: goalFields.accountId.optional(),
  budgetLineId: goalFields.budgetLineId.optional(),
  monthlyContribution: goalFields.monthlyContribution.optional(),
  savedBaseline: goalFields.savedBaseline.optional(),
  savedBaselineDate: goalFields.savedBaselineDate.optional(),
  position: goalFields.position.optional(),
});

export type CreateGoalInput = z.input<typeof createSchema>;
export type UpdateGoalPatch = z.input<typeof patchSchema>;
export type GoalWriteOptions = { now?: Date };

const EMERGENCY_FUND_UNIQUE = 'goal_emergency_fund_unique';
const emergencyFundExists = () =>
  new ValidationError('The household already has an emergency fund', [], 'emergency_fund_exists');

async function householdDay(tx: Tx, householdId: string, now: Date) {
  const [settings] = await tx
    .select({ timezone: householdSettings.timezone, currency: householdSettings.currency })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  if (!settings) throw new NotFoundError('Household settings');
  return {
    timezone: settings.timezone,
    currency: settings.currency,
    today: localDay(now, settings.timezone),
  };
}

/**
 * What a linked account counts as saved: its balance, never below zero (an overdraft is not
 * negative savings), and nothing for an account in another currency than the goal's (the
 * household's): amounts are never converted. A credit card saves nothing: its balance may be the
 * bank's available credit.
 */
function savedFromAccount(
  b: { balance: number; currency: string; type: string },
  currency: string,
): number {
  if (b.type === 'card') return 0;
  return b.currency === currency ? Math.max(0, b.balance) : 0;
}

/**
 * The baseline fields to write: an amount without a date is dated today (household calendar), a
 * cleared amount clears its date, and a date alone is refused (it needs its amount).
 */
async function baselineFields(
  tx: Tx,
  householdId: string,
  input: { savedBaseline?: number | null; savedBaselineDate?: string | null },
  now: Date,
): Promise<{ savedBaseline?: number | null; savedBaselineDate?: string | null }> {
  const { savedBaseline, savedBaselineDate } = input;
  if (savedBaseline === undefined) {
    if (savedBaselineDate !== undefined) {
      throw new ValidationError('An already-saved date needs its amount', [
        { path: ['savedBaselineDate'], message: 'needs savedBaseline' },
      ]);
    }
    return {};
  }
  if (savedBaseline === null) return { savedBaseline: null, savedBaselineDate: null };
  return {
    savedBaseline,
    savedBaselineDate: savedBaselineDate ?? (await householdDay(tx, householdId, now)).today,
  };
}

/**
 * What a goal linked to a budget line has saved by `today`, from that line in its budget's year
 * view: the baseline plus the line's monthly actuals for the months after the baseline date (with
 * no baseline: from the goal's creation month) up to the current month. Net withdrawals lower it,
 * but it never shows below zero. Null when the view has no such line.
 */
function savedFromLine(
  view: BudgetYearView,
  g: Pick<Goal, 'budgetLineId' | 'savedBaseline' | 'savedBaselineDate' | 'createdAt'>,
  timezone: string,
  today: string,
): number | null {
  const line = view.lines.find((l) => l.lineId === g.budgetLineId);
  if (!line) return null;
  const to = monthStart(today);
  const from = monthStart(localDay(g.createdAt, timezone));
  let saved = g.savedBaseline ?? 0;
  for (const m of view.months) {
    if (m.from > to) continue;
    const counts = g.savedBaselineDate !== null ? m.from > g.savedBaselineDate : m.from >= from;
    if (counts) saved += line.months[m.index - 1]!.actual;
  }
  return Math.max(saved, 0); // net withdrawals never show as negative progress
}

/**
 * When a goal leaves its budget line (re-linked to another line, e.g. next year's, or unlinked),
 * what the old line saved is rolled into the baseline so saved never resets: the baseline becomes
 * the old saved amount, dated today or, when the old line's budget year has already ended, its
 * last day (so the new year's months all count on top). Returns the baseline fields to write, or
 * null when the goal has no line. Callers skip account-linked goals: they ignore the baseline.
 */
export async function rolledBaselineInTx(
  tx: Tx,
  householdId: string,
  current: Goal,
  now: Date,
  views?: YearViewCache,
): Promise<{ savedBaseline: number; savedBaselineDate: string } | null> {
  if (!current.budgetLineId) return null;
  const budgetId = await requireBudgetLine(tx, householdId, current.budgetLineId);
  const view = await cachedYearView(tx, householdId, budgetId, views);
  const { timezone, today } = await householdDay(tx, householdId, now);
  const saved = savedFromLine(view, current, timezone, today);
  if (saved === null) return null;
  const yearEnd = view.months[view.months.length - 1]!.to;
  return { savedBaseline: saved, savedBaselineDate: today < yearEnd ? today : yearEnd };
}

/** Budget year views by budget id, so a loop over goals builds each budget's view once. */
export type YearViewCache = Map<string, Promise<BudgetYearView>>;

function cachedYearView(
  tx: Tx,
  householdId: string,
  budgetId: string,
  views: YearViewCache | undefined,
): Promise<BudgetYearView> {
  let view = views?.get(budgetId);
  if (!view) {
    view = budgetYearViewInTx(tx, householdId, budgetId);
    views?.set(budgetId, view);
  }
  return view;
}

/**
 * What a goal has saved today, by the rule listGoals shows: the linked account's balance (the
 * baseline is ignored then); for a goal on a budget line, savedFromLine; otherwise the baseline,
 * or 0. `views` caches the budget year views across goals.
 */
export async function currentSavedInTx(
  tx: Tx,
  householdId: string,
  g: Goal,
  now: Date,
  views?: YearViewCache,
): Promise<number> {
  const { timezone, currency, today } = await householdDay(tx, householdId, now);
  if (g.accountId) {
    const balances = await accountBalancesInTx(tx, householdId, today, { all: true });
    const mine = balances.find((b) => b.accountId === g.accountId);
    return mine ? savedFromAccount(mine, currency) : 0;
  }
  if (g.budgetLineId) {
    const budgetId = await requireBudgetLine(tx, householdId, g.budgetLineId);
    const view = await cachedYearView(tx, householdId, budgetId, views);
    const saved = savedFromLine(view, g, timezone, today);
    if (saved !== null) return saved;
  }
  return g.savedBaseline ?? 0;
}

async function requireBudgetLine(tx: Tx, householdId: string, id: string): Promise<string> {
  assertUuid(id, 'Budget line');
  const [row] = await tx
    .select({ budgetId: budgetLine.budgetId })
    .from(budgetLine)
    .where(and(eq(budgetLine.id, id), eq(budgetLine.householdId, householdId)));
  if (!row) throw new NotFoundError('Budget line');
  return row.budgetId;
}

async function requireLinks(
  tx: Tx,
  householdId: string,
  links: { accountId?: string | null | undefined; budgetLineId?: string | null | undefined },
): Promise<void> {
  if (links.accountId) await requireAccount(tx, householdId, links.accountId);
  if (links.budgetLineId) await requireBudgetLine(tx, householdId, links.budgetLineId);
}

/**
 * A household has at most one live emergency fund (the partial unique index is the guarantee, this
 * gives the friendly error). `exceptId` is the goal being changed.
 */
async function assertNoOtherEmergencyFund(
  tx: Tx,
  householdId: string,
  exceptId?: string,
): Promise<void> {
  const [other] = await tx
    .select({ id: goal.id })
    .from(goal)
    .where(
      and(
        eq(goal.householdId, householdId),
        eq(goal.kind, 'emergency_fund'),
        eq(goal.archived, false),
        exceptId ? ne(goal.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (other) throw emergencyFundExists();
}

/** Creates a goal inside a transaction. No role check. */
export async function createGoalInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateGoalInput,
  opts: GoalWriteOptions = {},
): Promise<Goal> {
  const input = parseInput(createSchema, rawInput);
  await requireLinks(tx, householdId, input);
  if (input.kind === 'emergency_fund') await assertNoOtherEmergencyFund(tx, householdId);
  const baseline = await baselineFields(tx, householdId, input, opts.now ?? new Date());
  try {
    const [row] = await tx
      .insert(goal)
      .values({ ...input, ...baseline, kind: input.kind ?? 'generic', householdId })
      .returning();
    return row!;
  } catch (err) {
    // A concurrent request added a fund after the check above: the index is the guarantee.
    if (isUniqueViolation(err, EMERGENCY_FUND_UNIQUE)) throw emergencyFundExists();
    throw err;
  }
}

export async function createGoal(
  ctx: ServiceCtx,
  rawInput: CreateGoalInput,
  opts: GoalWriteOptions = {},
): Promise<Goal> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createGoalInTx(tx, ctx.householdId, rawInput, opts),
  );
}

/**
 * Updates a goal inside a transaction. No role check. A change of `budgetLineId` rolls what the
 * old line saved into the baseline (see rolledBaselineInTx) unless the same patch sets the baseline.
 */
export async function updateGoalInTx(
  tx: Tx,
  householdId: string,
  id: string,
  rawPatch: UpdateGoalPatch,
  opts: GoalWriteOptions = {},
): Promise<Goal> {
  assertUuid(id, 'Goal');
  const now = opts.now ?? new Date();
  const patch = parseInput(patchSchema, rawPatch);
  await requireLinks(tx, householdId, patch);
  const where = and(eq(goal.id, id), eq(goal.householdId, householdId));
  const [current] = await tx.select().from(goal).where(where);
  if (!current) throw new NotFoundError('Goal');
  // An archived goal takes no slot, so only a live one is checked against the others.
  if (patch.kind === 'emergency_fund' && !current.archived) {
    await assertNoOtherEmergencyFund(tx, householdId, id);
  }
  const set = { ...patch, ...(await baselineFields(tx, householdId, patch, now)) };
  const accountLinked =
    (patch.accountId !== undefined ? patch.accountId : current.accountId) !== null;
  if (
    patch.budgetLineId !== undefined &&
    patch.budgetLineId !== current.budgetLineId &&
    patch.savedBaseline === undefined &&
    !accountLinked
  ) {
    Object.assign(set, await rolledBaselineInTx(tx, householdId, current, now));
  }
  if (Object.keys(set).length === 0) return current;
  try {
    const [row] = await tx.update(goal).set(set).where(where).returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, EMERGENCY_FUND_UNIQUE)) throw emergencyFundExists();
    throw err;
  }
}

export async function updateGoal(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateGoalPatch,
  opts: GoalWriteOptions = {},
): Promise<Goal> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    updateGoalInTx(tx, ctx.householdId, id, rawPatch, opts),
  );
}

/** Soft-removes a goal. Idempotent. */
export async function archiveGoal(ctx: ServiceCtx, id: string): Promise<Goal> {
  assertCanWrite(ctx);
  assertUuid(id, 'Goal');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .update(goal)
      .set({ archived: true })
      .where(and(eq(goal.id, id), eq(goal.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Goal');
    return row;
  });
}

/**
 * The current budget: the active one whose twelve months contain `today` (latest start wins).
 * The emergency fund's target and its average (see emergencyFundAverage) both come from it.
 */
async function currentBudgetIdInTx(
  tx: Tx,
  householdId: string,
  timezone: string,
  today: string,
): Promise<string | null> {
  const budgets = await tx
    .select({ id: budget.id, startMonth: budget.startMonth })
    .from(budget)
    .where(and(eq(budget.householdId, householdId), eq(budget.status, 'active')))
    .orderBy(desc(budget.startMonth));
  return (
    budgets.find((b) =>
      budgetMonths(b.startMonth, timezone).some((m) => m.from <= today && today <= m.to),
    )?.id ?? null
  );
}

/**
 * The average planned monthly expense of the current budget (the figure an emergency fund's
 * target multiplies by `emergency_fund_months`), or null when there is no current budget.
 */
export async function emergencyFundAverage(
  ctx: ServiceCtx,
  opts: { now?: Date } = {},
): Promise<number | null> {
  const now = opts.now ?? new Date();
  const found = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [settings] = await tx
      .select({ timezone: householdSettings.timezone })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    if (!settings) throw new NotFoundError('Household settings');
    return currentBudgetIdInTx(
      tx,
      ctx.householdId,
      settings.timezone,
      localDay(now, settings.timezone),
    );
  });
  if (!found) return null;
  const total = (await budgetYearView(ctx, found)).totals.expense.total.planned;
  return Math.round(total / 12);
}

/**
 * Goals with progress (read: any role). Saved is the linked account's balance today (the baseline
 * is ignored then); for a goal linked to a budget line, the baseline plus that line's monthly
 * actuals (the budget views' own numbers) after the baseline date, or from the goal's creation
 * month without one, up to the current month (see savedFromLine); otherwise the baseline, or 0.
 * The projection is
 * the core one. An emergency fund's target is the current budget's average planned monthly
 * expense times `household_settings.emergency_fund_months`; with no current budget the stored
 * target stands. `opts.now` fixes "today" for tests and jobs.
 */
export async function listGoals(
  ctx: ServiceCtx,
  opts: { includeArchived?: boolean; now?: Date } = {},
): Promise<GoalView[]> {
  const now = opts.now ?? new Date();
  const base = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [settings] = await tx
      .select({
        timezone: householdSettings.timezone,
        emergencyFundMonths: householdSettings.emergencyFundMonths,
        currency: householdSettings.currency,
      })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    if (!settings) throw new NotFoundError('Household settings');
    const today = localDay(now, settings.timezone);

    const goals = await tx
      .select()
      .from(goal)
      .where(
        and(
          eq(goal.householdId, ctx.householdId),
          opts.includeArchived ? undefined : eq(goal.archived, false),
        ),
      )
      .orderBy(asc(goal.position), asc(goal.name), asc(goal.id));

    const lineIds = [...new Set(goals.flatMap((g) => (g.budgetLineId ? [g.budgetLineId] : [])))];
    const lines =
      lineIds.length === 0
        ? []
        : await tx
            .select({ id: budgetLine.id, budgetId: budgetLine.budgetId })
            .from(budgetLine)
            .where(
              and(eq(budgetLine.householdId, ctx.householdId), inArray(budgetLine.id, lineIds)),
            );

    const currentBudgetId = goals.some((g) => g.kind === 'emergency_fund')
      ? await currentBudgetIdInTx(tx, ctx.householdId, settings.timezone, today)
      : null;

    const balances = goals.some((g) => g.accountId)
      ? new Map(
          (await accountBalancesInTx(tx, ctx.householdId, today, { all: true })).map((b) => [
            b.accountId,
            savedFromAccount(b, settings.currency),
          ]),
        )
      : new Map<string, number>();

    return {
      settings,
      today,
      goals,
      budgetOfLine: new Map(lines.map((l) => [l.id, l.budgetId])),
      currentBudgetId,
      balances,
    };
  });

  const { settings, today, budgetOfLine, currentBudgetId, balances } = base;
  const years = new Map<string, Promise<BudgetYearView>>();
  const yearView = (budgetId: string): Promise<BudgetYearView> => {
    let view = years.get(budgetId);
    if (!view) {
      view = budgetYearView(ctx, budgetId);
      years.set(budgetId, view);
    }
    return view;
  };

  let emergencyTarget: number | null = null;
  if (currentBudgetId) {
    const total = (await yearView(currentBudgetId)).totals.expense.total.planned;
    emergencyTarget = emergencyFundTarget(Math.round(total / 12), settings.emergencyFundMonths);
  }

  const out: GoalView[] = [];
  for (const g of base.goals) {
    let saved = g.accountId ? (balances.get(g.accountId) ?? 0) : (g.savedBaseline ?? 0);
    let linePlanThisMonth = 0;
    const budgetId = g.budgetLineId ? budgetOfLine.get(g.budgetLineId) : undefined;
    if (g.budgetLineId && budgetId) {
      const view = await yearView(budgetId);
      const line = view.lines.find((l) => l.lineId === g.budgetLineId);
      if (line) {
        if (!g.accountId) saved = savedFromLine(view, g, settings.timezone, today) ?? saved;
        const current = view.months.find((m) => m.from <= today && today <= m.to);
        if (current) linePlanThisMonth = line.months[current.index - 1]!.planned;
      }
    }
    const target =
      g.kind === 'emergency_fund' && emergencyTarget !== null ? emergencyTarget : g.targetAmount;
    const contribution = g.monthlyContribution ?? linePlanThisMonth;
    out.push({
      ...g,
      target,
      saved,
      contribution,
      projection: projectGoal({ target, saved, monthlyContribution: contribution, today }),
    });
  }
  return out;
}
