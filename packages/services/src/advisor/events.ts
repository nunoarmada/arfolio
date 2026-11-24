// What the advisor may write to a member unprompted. `detectEvents` is pure (it decides from the
// numbers it is given); the loaders read them. Every figure that reaches the model comes from here.
import { and, eq, gte, sql } from 'drizzle-orm';
import { addDays, budgetMonths, merchantKey as textKey, type BudgetMonth } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import { budgetMonthView, listBudgets } from '../budgets.js';
import type { ServiceCtx } from '../context.js';
import { listGoals, type GoalView } from '../goals.js';
import { householdToday } from '../net-worth.js';
import { createNotificationInTx } from '../notifications.js';
import { listRecurring, type Recurring } from '../recurring.js';
import { findTransferCategory, notTransferFilter } from '../transactions.js';
import { loadSpendingProfile } from './profile-data.js';
import type { SpendingProfile } from './profile.js';

const { transaction, advisorMessage } = schema;

export type AdvisorEventType =
  | 'welcome'
  | 'learned'
  | 'checkin'
  | 'goal_behind'
  | 'unusual_income'
  | 'new_recurring'
  | 'budget_over';

export type AdvisorEvent = {
  /** Unique per member (`advisor_message.event_key`): an event already sent is never sent again. */
  key: string;
  type: AdvisorEventType;
  /** Figures and names for the model; the engine neutralises and sanitises them. */
  facts: Record<string, unknown>;
  /** Welcome and "what I learned" are outside the weekly cap. */
  countsTowardCap: boolean;
};

export type Inflow = { id: string; amount: number; bookedOn: string; recurring: boolean };
export type LineMonth = { lineId: string; name: string; planned: number; actual: number };

export type EventInput = {
  /** `yyyy-mm-dd` in the household timezone. */
  today: string;
  profile: SpendingProfile;
  goals: GoalView[];
  /** Recurring items detected in the last few days (already filtered by the loader). */
  recurringNew: Recurring[];
  /** Positive, booked, non-transfer rows of the household currency (amounts in minor units). */
  recentInflows: Inflow[];
  /** Expense lines of the current budget month. */
  lineMonth: LineMonth[];
  hasAnyMessage: boolean;
  learnedSent: boolean;
};

/** The check-in goes out on these days of the month, for the month before. */
const CHECKIN_LAST_DAY = 7;
/** A goal projecting under this share of its target is "behind". */
const GOAL_BEHIND_PERCENT = 90;
/** An inflow this share of a typical month's income (or more) is worth a word. */
const INCOME_PERCENT = 50;
/** A line this far over its plan (strictly above) is worth a word. */
const BUDGET_OVER_PERCENT = 110;
/** Days an inflow or a new detection stays "recent". */
export const RECENT_DAYS = 3;

const previousMonth = (today: string): string => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1
    ? `${String(year - 1).padStart(4, '0')}-12`
    : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`;
};

/** Whole months from `today` to `date`; 0 once it is the same month or past. */
function monthsLeft(today: string, date: string): number {
  const diff =
    (Number(date.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
    (Number(date.slice(5, 7)) - Number(today.slice(5, 7))) -
    (Number(date.slice(8, 10)) < Number(today.slice(8, 10)) ? 1 : 0);
  return Math.max(0, diff);
}

/** Welcome, learned, then the capped events in a fixed order (see the design spec). */
export function detectEvents(input: EventInput): AdvisorEvent[] {
  const { today, profile } = input;
  const month = today.slice(0, 7);
  const out: AdvisorEvent[] = [];

  if (!input.hasAnyMessage) {
    out.push({
      key: 'welcome',
      type: 'welcome',
      facts: {
        event: 'welcome',
        learningMonthsRequired: profile.learning.required,
        completeMonths: profile.learning.completeMonths,
      },
      countsTowardCap: false,
    });
  }
  if (profile.learning.ready && !input.learnedSent) {
    out.push({
      key: 'learned',
      type: 'learned',
      facts: { event: 'learning_complete', completeMonths: profile.learning.completeMonths },
      countsTowardCap: false,
    });
  }

  if (Number(today.slice(8, 10)) <= CHECKIN_LAST_DAY) {
    const reported = previousMonth(today);
    out.push({
      key: `checkin:${reported}`,
      type: 'checkin',
      facts: { event: 'monthly_check_in', month: reported },
      countsTowardCap: true,
    });
  }

  for (const g of input.goals) {
    if (g.target === null || g.target <= 0 || g.targetDate === null) continue;
    const left = monthsLeft(today, g.targetDate);
    const projected = g.saved + g.contribution * left;
    if (projected * 100 >= g.target * GOAL_BEHIND_PERCENT) continue;
    out.push({
      key: `goal_behind:${g.id}:${month}`,
      type: 'goal_behind',
      facts: {
        event: 'goal_behind',
        goal: g.name,
        target: g.target,
        saved: g.saved,
        monthlyContribution: g.contribution,
        targetDate: g.targetDate,
        monthsLeft: left,
        projectedAtTargetDate: projected,
      },
      countsTowardCap: true,
    });
  }

  const typicalIncome = profile.learning.ready ? (profile.income?.median ?? 0) : 0;
  if (typicalIncome > 0) {
    const since = addDays(today, -RECENT_DAYS);
    for (const f of input.recentInflows) {
      if (f.recurring || f.bookedOn < since) continue;
      if (f.amount * 100 < typicalIncome * INCOME_PERCENT) continue;
      out.push({
        key: `income:${f.id}`,
        type: 'unusual_income',
        facts: {
          event: 'unusual_income',
          amount: f.amount,
          bookedOn: f.bookedOn,
          typicalMonthlyIncome: typicalIncome,
        },
        countsTowardCap: true,
      });
    }
  }

  for (const r of input.recurringNew) {
    out.push({
      key: `recurring:${r.id}`,
      type: 'new_recurring',
      facts: {
        event: 'new_recurring',
        name: r.name,
        amount: r.amount,
        currency: r.currency,
        cadence: r.cadence,
      },
      countsTowardCap: true,
    });
  }

  for (const l of input.lineMonth) {
    if (l.planned <= 0 || l.actual * 100 <= l.planned * BUDGET_OVER_PERCENT) continue;
    out.push({
      key: `budget:${l.lineId}:${month}`,
      type: 'budget_over',
      facts: {
        event: 'budget_over',
        line: l.name,
        month,
        planned: l.planned,
        actual: l.actual,
      },
      countsTowardCap: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Loading

export type HouseholdSignals = Pick<
  EventInput,
  'today' | 'profile' | 'goals' | 'recurringNew' | 'recentInflows' | 'lineMonth'
>;

/** The budget month containing `today`, latest budget start winning when several overlap. */
async function currentLines(
  ctx: ServiceCtx,
  timezone: string,
  today: string,
): Promise<LineMonth[]> {
  const budgets = (await listBudgets(ctx))
    .filter((b) => b.status === 'active')
    .sort((a, b) => b.startMonth.localeCompare(a.startMonth));
  for (const b of budgets) {
    const found: BudgetMonth | undefined = budgetMonths(b.startMonth, timezone).find(
      (m) => m.from <= today && today <= m.to,
    );
    if (!found) continue;
    const view = await budgetMonthView(ctx, b.id, found.index);
    return view.lines
      .filter((l) => l.kind === 'expense' && l.planned > 0)
      .map((l) => ({ lineId: l.lineId, name: l.name, planned: l.planned, actual: l.actual }));
  }
  return [];
}

/**
 * Everything `detectEvents` needs that is the same for every member of the household. Loaded
 * once per run; nothing here is written.
 */
export async function loadHouseholdSignals(
  ctx: ServiceCtx,
  opts: { learningMonths: number; now?: Date },
): Promise<HouseholdSignals> {
  const now = opts.now ?? new Date();
  const clock = await householdToday(ctx, now);
  const { today } = clock;
  const [profile, goals, items] = await Promise.all([
    loadSpendingProfile(ctx, { learningMonths: opts.learningMonths, today }),
    listGoals(ctx, { now }),
    listRecurring(ctx),
  ]);

  const since = now.getTime() - RECENT_DAYS * 86_400_000;
  const recurringNew = items.filter(
    (r) => r.status === 'detected' && r.createdAt.getTime() >= since,
  );

  // Known income series: an inflow whose text key matches one is expected, not unusual.
  const knownIncome = new Set(
    items
      .filter((r) => r.status !== 'dismissed' && r.amount > 0)
      .flatMap((r) => [r.merchantKey, textKey(r.merchantKey)]),
  );
  const recentInflows = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select({
        id: transaction.id,
        amount: transaction.amount,
        bookedOn: transaction.purchaseDate,
        rawDescription: transaction.rawDescription,
        counterparty: transaction.counterparty,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.status, 'booked'),
          eq(transaction.currency, clock.currency),
          sql`${transaction.amount} > 0`,
          gte(transaction.purchaseDate, addDays(today, -RECENT_DAYS)),
          notTransferFilter(await findTransferCategory(tx, ctx.householdId)),
        ),
      );
    return rows.map((r): Inflow => ({
      id: r.id,
      amount: r.amount,
      bookedOn: r.bookedOn,
      recurring: knownIncome.has(textKey(r.rawDescription, r.counterparty)),
    }));
  });

  return {
    today,
    profile,
    goals,
    recurringNew,
    recentInflows,
    lineMonth: await currentLines(ctx, clock.timeZone, today),
  };
}

/** What this member has already been sent: drives the one-off welcome and "learned" messages. */
export async function loadSentState(
  ctx: ServiceCtx,
): Promise<Pick<EventInput, 'hasAnyMessage' | 'learnedSent'>> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const mine = and(
      eq(advisorMessage.householdId, ctx.householdId),
      eq(advisorMessage.userId, ctx.userId),
    );
    const [any] = await tx
      .select({ id: advisorMessage.id })
      .from(advisorMessage)
      .where(mine)
      .limit(1);
    const [learned] = await tx
      .select({ id: advisorMessage.id })
      .from(advisorMessage)
      .where(and(mine, eq(advisorMessage.eventKey, 'learned')))
      .limit(1);
    return { hasAnyMessage: any !== undefined, learnedSent: learned !== undefined };
  });
}

/**
 * Tells one member a proactive message is waiting: an in-app notification (and so a push) for that
 * user alone. The payload carries the message id, never its text. True when it was created.
 */
export async function notifyAdvisorMessage(
  ctx: Pick<ServiceCtx, 'db' | 'householdId' | 'userId'>,
  input: { messageId: string; eventKey: string },
): Promise<boolean> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createNotificationInTx(tx, {
      householdId: ctx.householdId,
      userId: ctx.userId,
      kind: 'advisor_message',
      payload: { messageId: input.messageId },
      dedupeKey: `advisor:${ctx.userId}:${input.eventKey}`,
    }),
  );
}
