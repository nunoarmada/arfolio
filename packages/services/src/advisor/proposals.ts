import { and, desc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { InvalidAmountError, parseMoneyInput } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { recordAudit } from '../audit.js';
import { getBudgetLine, setLineAmounts } from '../budgets.js';
import {
  assertCanWrite,
  assertUuid,
  calendarDate,
  ConflictError,
  MAX_AMOUNT_MINOR,
  NotFoundError,
  ValidationError,
  type ServiceCtx,
} from '../context.js';
import { createGoal, updateGoal } from '../goals.js';
import { createRule, ruleConditionSchema } from '../rules.js';
import { categoriseTransaction } from '../transactions.js';
import { getProposal, type AdvisorProposal } from './store.js';
import type { SpendingProfile, TypicalSpend } from './profile.js';

const { advisorMessage, advisorProposal, budget, budgetLine, category, financialAccount, goal } =
  schema;
const { transaction } = schema;

/** How many of the member's latest messages can vouch for an amount they "stated". */
const RECENT_USER_MESSAGES = 10;

const amountText = z.string().trim().min(1).max(32);
const common = { statedByMember: z.boolean(), reason: z.string().max(300) };
const id = z.string().min(1).max(64);

/** What the model may propose. Amounts are decimal strings in the household currency. */
export const proposalDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('goal_create'),
    name: z.string().trim().min(1).max(120),
    goalKind: z.enum(['generic', 'emergency_fund']).optional(),
    targetAmount: amountText.optional(),
    targetDate: calendarDate.optional(),
    monthlyContribution: amountText.optional(),
    accountId: id.optional(),
    ...common,
  }),
  z
    .strictObject({
      kind: z.literal('goal_update'),
      goalId: id,
      targetAmount: amountText.optional(),
      targetDate: calendarDate.optional(),
      monthlyContribution: amountText.optional(),
      ...common,
    })
    .refine(
      (d) =>
        d.targetAmount !== undefined ||
        d.targetDate !== undefined ||
        d.monthlyContribution !== undefined,
      'a goal update must change something',
    ),
  z.strictObject({
    kind: z.literal('budget_line_amount'),
    lineId: id,
    monthlyAmount: amountText,
    fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM'),
    ...common,
  }),
  z.strictObject({
    kind: z.literal('rule_create'),
    name: z.string().trim().min(1).max(120),
    categoryId: id,
    condition: ruleConditionSchema,
    ...common,
  }),
  z.strictObject({
    kind: z.literal('transaction_categorise'),
    transactionId: id,
    categoryId: id,
    applyToMerchant: z.boolean().optional(),
    ...common,
  }),
]);
export type ProposalDraft = z.output<typeof proposalDraftSchema>;

/** The figures a proposed amount was judged against (minor units). */
export type ProposalBasis = {
  months: number;
  min: number;
  max: number;
  median: number;
  currency: string;
};

export type DraftVerdict =
  | { ok: true; basis: ProposalBasis | null; targetUpdatedAt: Date | null }
  | { ok: false; code: 'learning' | 'out_of_range' | 'not_found' | 'invalid' };

const refuse = (code: Extract<DraftVerdict, { ok: false }>['code']): DraftVerdict => ({
  ok: false,
  code,
});

/** Non-negative minor units of a decimal string, or null when it is not a valid amount. */
function minorOf(text: string, currency: string): number | null {
  try {
    const minor = parseMoneyInput(text, currency);
    return minor < 0 || minor > MAX_AMOUNT_MINOR ? null : minor;
  } catch (err) {
    if (err instanceof InvalidAmountError) return null;
    throw err;
  }
}

const canonical = (whole: string, fraction: string): string => {
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = fraction.replace(/0+$/, '');
  return f ? `${w}.${f}` : w;
};

const NUMBER_IN_TEXT = /\d{1,3}(?:[ \u00a0.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

/**
 * Whether a message of the member contains the amount: numbers are compared as digits, so "250"
 * is found in "250 €", "250,00" and "EUR 250", but not inside "2500" or "1250".
 */
function mentionsAmount(texts: string[], amount: string): boolean {
  const [whole = '', fraction = ''] = amount.split('.');
  const wanted = canonical(whole, fraction);
  return texts.some((text) =>
    (text.match(NUMBER_IN_TEXT) ?? []).some((token) => {
      const decimals = /[.,](\d{1,2})$/.exec(token);
      const integer = (decimals ? token.slice(0, decimals.index) : token).replace(/\D/g, '');
      return canonical(integer, decimals?.[1] ?? '') === wanted;
    }),
  );
}

const basisOf = (t: TypicalSpend, currency: string): ProposalBasis => ({
  months: t.months,
  min: t.min,
  max: t.max,
  median: t.median,
  currency,
});

const isUuid = (value: string): boolean => {
  try {
    assertUuid(value, 'Id');
    return true;
  } catch {
    return false;
  }
};

async function accountExists(tx: Tx, ctx: ServiceCtx, value: string): Promise<boolean> {
  if (!isUuid(value)) return false;
  const [row] = await tx
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(and(eq(financialAccount.id, value), eq(financialAccount.householdId, ctx.householdId)));
  return row !== undefined;
}

async function categoryExists(tx: Tx, ctx: ServiceCtx, value: string): Promise<boolean> {
  if (!isUuid(value)) return false;
  const [row] = await tx
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.id, value), eq(category.householdId, ctx.householdId)));
  return row !== undefined;
}

type Judge = { profile: SpendingProfile; recentUserTexts: string[] };

/** The monthly contribution rule: at most median income minus median total spending. */
function judgeContribution(text: string, minor: number, j: Judge, stated: boolean): DraftVerdict {
  const { income, categories, currency } = j.profile;
  const spend = categories.reduce((sum, c) => sum + (c.typical?.median ?? 0), 0);
  const free = income ? Math.max(0, income.median - spend) : null;
  const basis = income ? basisOf(income, currency) : null;
  const fine = free !== null && minor <= free;
  if (fine || (stated && mentionsAmount(j.recentUserTexts, text))) {
    return { ok: true, basis, targetUpdatedAt: null };
  }
  return refuse('out_of_range');
}

/**
 * Checks a draft against the household's data and spending profile before it is stored as a
 * proposal (and again when it is applied). Goal target amounts are free; budget amounts and
 * monthly contributions need a finished learning period and must sit inside what the household
 * normally does, unless the member said the number themselves.
 */
export async function validateDraft(
  ctx: ServiceCtx,
  draft: ProposalDraft,
  judge: Judge,
): Promise<DraftVerdict> {
  const { currency, learning } = judge.profile;
  const ok = (basis: ProposalBasis | null = null, targetUpdatedAt: Date | null = null) =>
    ({ ok: true, basis, targetUpdatedAt }) satisfies DraftVerdict;

  const amounts: Record<string, number> = {};
  for (const [key, text] of [
    ['target', 'targetAmount' in draft ? draft.targetAmount : undefined],
    ['contribution', 'monthlyContribution' in draft ? draft.monthlyContribution : undefined],
    ['line', draft.kind === 'budget_line_amount' ? draft.monthlyAmount : undefined],
  ] as const) {
    if (text === undefined) continue;
    const minor = minorOf(text, currency);
    if (minor === null) return refuse('invalid');
    amounts[key] = minor;
  }
  const needsLearning = amounts.contribution !== undefined || draft.kind === 'budget_line_amount';
  if (needsLearning && !learning.ready) return refuse('learning');

  return withHousehold(ctx.db, ctx.householdId, async (tx): Promise<DraftVerdict> => {
    switch (draft.kind) {
      case 'goal_create': {
        if (draft.accountId !== undefined && !(await accountExists(tx, ctx, draft.accountId))) {
          return refuse('not_found');
        }
        if (amounts.contribution === undefined) return ok();
        return judgeContribution(
          draft.monthlyContribution!,
          amounts.contribution,
          judge,
          draft.statedByMember,
        );
      }
      case 'goal_update': {
        const [row] = isUuid(draft.goalId)
          ? await tx
              .select({ updatedAt: goal.updatedAt })
              .from(goal)
              .where(and(eq(goal.id, draft.goalId), eq(goal.householdId, ctx.householdId)))
          : [];
        if (!row) return refuse('not_found');
        if (amounts.contribution === undefined) return ok(null, row.updatedAt);
        const verdict = judgeContribution(
          draft.monthlyContribution!,
          amounts.contribution,
          judge,
          draft.statedByMember,
        );
        return verdict.ok ? { ...verdict, targetUpdatedAt: row.updatedAt } : verdict;
      }
      case 'budget_line_amount': {
        const [row] = isUuid(draft.lineId)
          ? await tx
              .select({ updatedAt: budgetLine.updatedAt, startMonth: budget.startMonth })
              .from(budgetLine)
              .innerJoin(budget, eq(budget.id, budgetLine.budgetId))
              .where(
                and(eq(budgetLine.id, draft.lineId), eq(budgetLine.householdId, ctx.householdId)),
              )
          : [];
        if (!row) return refuse('not_found');
        if (budgetMonthIndex(row.startMonth, draft.fromMonth) === null) return refuse('invalid');
        const typical = judge.profile.budgetLines.find((l) => l.lineId === draft.lineId)?.typical;
        const basis = typical ? basisOf(typical, currency) : null;
        const inside = typical && amounts.line! >= typical.min && amounts.line! <= typical.max;
        const stated =
          draft.statedByMember && mentionsAmount(judge.recentUserTexts, draft.monthlyAmount);
        return inside || stated ? ok(basis, row.updatedAt) : refuse('out_of_range');
      }
      case 'rule_create':
        return (await categoryExists(tx, ctx, draft.categoryId)) ? ok() : refuse('not_found');
      case 'transaction_categorise': {
        const found =
          isUuid(draft.transactionId) &&
          (
            await tx
              .select({ id: transaction.id })
              .from(transaction)
              .where(
                and(
                  eq(transaction.id, draft.transactionId),
                  eq(transaction.householdId, ctx.householdId),
                ),
              )
          ).length > 0;
        return found && (await categoryExists(tx, ctx, draft.categoryId))
          ? ok()
          : refuse('not_found');
      }
    }
  });
}

/** Month 1..12 of a budget year (`startMonth` is `yyyy-mm-01`) that `month` (`yyyy-mm`) is. */
function budgetMonthIndex(startMonth: string, month: string): number | null {
  const index = (v: string) => Number(v.slice(0, 4)) * 12 + Number(v.slice(5, 7));
  const n = index(month) - index(startMonth) + 1;
  return n >= 1 && n <= 12 ? n : null;
}

/** Moves a proposal out of `from`; false when it was no longer there (someone got there first). */
async function transition(
  ctx: ServiceCtx,
  proposalId: string,
  from: AdvisorProposal['status'],
  to: AdvisorProposal['status'],
): Promise<AdvisorProposal | null> {
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .update(advisorProposal)
      .set({ status: to, resolvedAt: to === 'pending' ? null : new Date() })
      .where(
        and(
          eq(advisorProposal.id, proposalId),
          eq(advisorProposal.householdId, ctx.householdId),
          eq(advisorProposal.userId, ctx.userId),
          eq(advisorProposal.status, from),
        ),
      )
      .returning(),
  );
  return row ?? null;
}

/** Not claimable: either it is not this member's (not found) or it was already resolved. */
async function notPending(ctx: ServiceCtx, proposalId: string): Promise<never> {
  await getProposal(ctx, proposalId);
  throw new ConflictError('proposal_not_pending', 'The proposal was already resolved');
}

async function recentUserTexts(ctx: ServiceCtx, until: Date): Promise<string[]> {
  const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ text: advisorMessage.text })
      .from(advisorMessage)
      .where(
        and(
          eq(advisorMessage.householdId, ctx.householdId),
          eq(advisorMessage.userId, ctx.userId),
          eq(advisorMessage.role, 'user'),
          lte(advisorMessage.createdAt, until),
        ),
      )
      .orderBy(desc(advisorMessage.createdAt), desc(advisorMessage.id))
      .limit(RECENT_USER_MESSAGES),
  );
  return rows.map((r) => r.text);
}

const stale = () =>
  new ValidationError('The proposal no longer matches the current data', [], 'stale');

/** Runs the one write a draft stands for and says what it touched, for the audit row. */
async function perform(
  ctx: ServiceCtx,
  draft: ProposalDraft,
  currency: string,
): Promise<{ targetType: string; targetId: string }> {
  const money = (text: string | undefined) =>
    text === undefined ? undefined : minorOf(text, currency)!;
  switch (draft.kind) {
    case 'goal_create': {
      const created = await createGoal(ctx, {
        name: draft.name,
        ...(draft.goalKind ? { kind: draft.goalKind } : {}),
        ...(draft.targetAmount !== undefined ? { targetAmount: money(draft.targetAmount)! } : {}),
        ...(draft.targetDate !== undefined ? { targetDate: draft.targetDate } : {}),
        ...(draft.monthlyContribution !== undefined
          ? { monthlyContribution: money(draft.monthlyContribution)! }
          : {}),
        ...(draft.accountId !== undefined ? { accountId: draft.accountId } : {}),
      });
      return { targetType: 'goal', targetId: created.id };
    }
    case 'goal_update': {
      const updated = await updateGoal(ctx, draft.goalId, {
        ...(draft.targetAmount !== undefined ? { targetAmount: money(draft.targetAmount)! } : {}),
        ...(draft.targetDate !== undefined ? { targetDate: draft.targetDate } : {}),
        ...(draft.monthlyContribution !== undefined
          ? { monthlyContribution: money(draft.monthlyContribution)! }
          : {}),
      });
      return { targetType: 'goal', targetId: updated.id };
    }
    case 'budget_line_amount': {
      const line = await getBudgetLine(ctx, draft.lineId);
      const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx
          .select({ startMonth: budget.startMonth })
          .from(budget)
          .where(and(eq(budget.id, line.budgetId), eq(budget.householdId, ctx.householdId))),
      );
      const from = row ? budgetMonthIndex(row.startMonth, draft.fromMonth) : null;
      if (from === null) throw new ValidationError('The month is outside the budget year');
      const amount = money(draft.monthlyAmount)!;
      await setLineAmounts(
        ctx,
        draft.lineId,
        line.amounts.map((current, i) => (i + 1 >= from ? amount : current)),
      );
      return { targetType: 'budget_line', targetId: draft.lineId };
    }
    case 'rule_create': {
      const created = await createRule(ctx, {
        name: draft.name,
        categoryId: draft.categoryId,
        condition: draft.condition,
      });
      return { targetType: 'rule', targetId: created.id };
    }
    case 'transaction_categorise': {
      // Other rows of the merchant change only when the proposal said so.
      const done = await categoriseTransaction(ctx, {
        id: draft.transactionId,
        categoryId: draft.categoryId,
        applyToMerchant: draft.applyToMerchant ?? false,
      });
      return { targetType: 'transaction', targetId: done.transaction.id };
    }
  }
}

/**
 * Applies a pending proposal of the member. The status flip is the lock: two clicks race for it
 * and only one proceeds (the other gets a ConflictError). The draft is judged again against
 * today's data and profile; a changed or vanished target makes the proposal `stale`. A failing
 * write puts the proposal back to `pending`.
 */
export async function applyProposal(
  ctx: ServiceCtx,
  proposalId: string,
  opts: { profile: SpendingProfile },
): Promise<'applied'> {
  assertCanWrite(ctx);
  assertUuid(proposalId, 'Proposal');
  const claimed = await transition(ctx, proposalId, 'pending', 'applied');
  if (!claimed) return notPending(ctx, proposalId);

  let done: { targetType: string; targetId: string };
  try {
    const parsed = proposalDraftSchema.safeParse(claimed.payload);
    if (!parsed.success || parsed.data.kind !== claimed.kind) {
      throw new ValidationError('The stored proposal is not valid', [], undefined);
    }
    const draft = parsed.data;
    const verdict = await validateDraft(ctx, draft, {
      profile: opts.profile,
      recentUserTexts: await recentUserTexts(ctx, claimed.createdAt),
    });
    if (!verdict.ok) {
      const targeted = draft.kind === 'goal_update' || draft.kind === 'budget_line_amount';
      if (verdict.code === 'not_found') {
        throw targeted ? stale() : new NotFoundError('Proposal target');
      }
      throw new ValidationError(
        `The proposal is not acceptable (${verdict.code})`,
        [],
        verdict.code === 'invalid' ? undefined : verdict.code,
      );
    }
    if (
      claimed.targetUpdatedAt &&
      verdict.targetUpdatedAt &&
      verdict.targetUpdatedAt.getTime() > claimed.targetUpdatedAt.getTime()
    ) {
      throw stale();
    }
    done = await perform(ctx, draft, opts.profile.currency);
  } catch (err) {
    if (err instanceof ValidationError && err.code === 'stale') {
      await transition(ctx, proposalId, 'applied', 'stale');
    } else {
      await transition(ctx, proposalId, 'applied', 'pending');
    }
    throw err;
  }

  // Outside the try: the change is made, so a failing audit write must not reopen the proposal.
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    recordAudit(tx, ctx, {
      actor: 'web',
      action: `advisor.apply.${claimed.kind}`,
      targetType: done.targetType,
      targetId: done.targetId,
    }),
  );
  return 'applied';
}

/** Dismisses a pending proposal of the member; nothing in the household changes. */
export async function dismissProposal(ctx: ServiceCtx, proposalId: string): Promise<void> {
  assertUuid(proposalId, 'Proposal');
  const row = await transition(ctx, proposalId, 'pending', 'dismissed');
  if (!row) await notPending(ctx, proposalId);
}
