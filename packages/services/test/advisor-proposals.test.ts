import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  appendMessage,
  applyProposal,
  ConflictError,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  createGoal,
  dismissProposal,
  ForbiddenError,
  getBudgetLine,
  getProposal,
  listGoals,
  listRules,
  NotFoundError,
  proposalDraftSchema,
  recentUserTexts,
  saveProposal,
  storedBasis,
  setLineAmounts,
  updateGoal,
  upsertBudgetLine,
  validateDraft,
  ValidationError,
  type ProposalDraft,
  type ServiceCtx,
  type SpendingProfile,
  type TypicalSpend,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { auditLog, user } = schema;

const typical = (median: number, min = median, max = median): TypicalSpend => ({
  median,
  min,
  max,
  months: 6,
  outlierMonths: [],
});

function profileOf(over: Partial<SpendingProfile> = {}): SpendingProfile {
  return {
    learning: { ready: true, completeMonths: 6, required: 3 },
    currency: 'EUR',
    window: [],
    categories: [
      { categoryId: 'c1', name: 'Food', group: 'Food', typical: typical(100_000) },
      { categoryId: 'c2', name: 'Home', group: 'Home', typical: typical(100_000) },
      { categoryId: 'c3', name: 'Fun', group: 'Fun', typical: null },
    ],
    income: typical(300_000, 280_000, 320_000),
    recurringMonthly: 0,
    budgetLines: [],
    ...over,
  };
}

const NOT_STATED = { recentUserTexts: [] as string[] };

describe('advisor proposals', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** A household with one real member (advisor rows have a FK to "user"). */
  async function world(role: ServiceCtx['role'] = 'owner'): Promise<ServiceCtx> {
    const base = await t.household({ currency: 'EUR', role });
    const id = `u_${randomUUID()}`;
    await t.owner
      .insert(user)
      .values({ id, name: 'Member', email: `${id}@example.com`, createdAt: new Date() });
    return { ...base, userId: id };
  }

  /** A pending proposal stored the way the model tool will store it. */
  async function propose(
    ctx: ServiceCtx,
    draft: ProposalDraft,
    profile: SpendingProfile = profileOf(),
    recentUserTexts: string[] = [],
  ) {
    const msg = await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: 'ok' });
    const verdict = await validateDraft(ctx, draft, { profile, recentUserTexts });
    if (!verdict.ok) throw new Error(`draft refused: ${verdict.code}`);
    return saveProposal(ctx, {
      messageId: msg!.id,
      kind: draft.kind,
      payload: draft,
      basis: storedBasis(verdict),
      targetUpdatedAt: verdict.targetUpdatedAt,
    });
  }

  const goalDraft = (over: Record<string, unknown> = {}): ProposalDraft =>
    proposalDraftSchema.parse({
      kind: 'goal_create',
      name: 'Trip',
      statedByMember: false,
      reason: 'You asked for it',
      ...over,
    });

  /** An expense line with amounts 200.00 a month in a 2026 budget, and its typical range. */
  async function lineWorld(ctx: ServiceCtx) {
    const budget = await createBudget(ctx, { startMonth: '2026-01-01' });
    const line = await upsertBudgetLine(ctx, budget.id, { kind: 'expense', name: 'Restaurants' });
    await setLineAmounts(
      ctx,
      line.id,
      Array.from({ length: 12 }, () => 20_000),
    );
    const profile = profileOf({
      budgetLines: [
        {
          lineId: line.id,
          name: 'Restaurants',
          typical: typical(21_000, 18_000, 24_000),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    return { line, profile };
  }
  const lineDraft = (lineId: string, monthlyAmount: string, over: Record<string, unknown> = {}) =>
    proposalDraftSchema.parse({
      kind: 'budget_line_amount',
      lineId,
      monthlyAmount,
      fromMonth: '2026-06',
      statedByMember: false,
      reason: 'Closer to what you spend',
      ...over,
    });

  describe('validateDraft', () => {
    it('refuses budget amounts while learning', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const learning = {
        ...profile,
        learning: { ready: false, completeMonths: 1, required: 3 },
      };
      expect(
        await validateDraft(ctx, lineDraft(line.id, '200'), {
          profile: learning,
          ...NOT_STATED,
        }),
      ).toEqual({ ok: false, code: 'learning' });
      expect(
        await validateDraft(ctx, goalDraft({ monthlyContribution: '50' }), {
          profile: learning,
          ...NOT_STATED,
        }),
      ).toEqual({ ok: false, code: 'learning' });
    });

    it('allows a goal target amount while learning', async () => {
      const ctx = await world();
      const learning = profileOf({ learning: { ready: false, completeMonths: 0, required: 3 } });
      expect(
        await validateDraft(ctx, goalDraft({ targetAmount: '5000' }), {
          profile: learning,
          ...NOT_STATED,
        }),
      ).toEqual({ ok: true, basis: null, targetUpdatedAt: null });
    });

    it('accepts an amount inside the observed range and reports its basis', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const verdict = await validateDraft(ctx, lineDraft(line.id, '200'), {
        profile,
        ...NOT_STATED,
      });
      expect(verdict).toMatchObject({
        ok: true,
        basis: { months: 6, min: 18_000, max: 24_000, median: 21_000, currency: 'EUR' },
      });
      expect(verdict.ok && verdict.targetUpdatedAt).toBeInstanceOf(Date);
    });

    it('refuses an amount outside the observed range', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      expect(
        await validateDraft(ctx, lineDraft(line.id, '300'), { profile, ...NOT_STATED }),
      ).toEqual({ ok: false, code: 'out_of_range' });
    });

    it('accepts an out-of-range amount the member stated', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const verdict = await validateDraft(
        ctx,
        lineDraft(line.id, '300', { statedByMember: true }),
        { profile, recentUserTexts: ['quero 300 € para restaurantes'] },
      );
      expect(verdict.ok).toBe(true);
    });

    it('matches a stated amount written with decimals', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const verdict = await validateDraft(
        ctx,
        lineDraft(line.id, '250', { statedByMember: true }),
        { profile, recentUserTexts: ['pode ser 250,00'] },
      );
      expect(verdict.ok).toBe(true);
    });

    it('rejects statedByMember when the member never said it', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const claimed = lineDraft(line.id, '300', { statedByMember: true });
      expect(
        await validateDraft(ctx, claimed, {
          profile,
          recentUserTexts: ['quero gastar menos em restaurantes', 'talvez 30 por semana'],
        }),
      ).toEqual({ ok: false, code: 'out_of_range' });
      // Digits that merely contain the amount ("3000") do not count either.
      expect(
        await validateDraft(ctx, claimed, { profile, recentUserTexts: ['tenho 3000 guardados'] }),
      ).toEqual({ ok: false, code: 'out_of_range' });
    });

    it('treats a line missing from the profile like one without history', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const unknown = { ...profile, budgetLines: [] };
      expect(
        await validateDraft(ctx, lineDraft(line.id, '200'), { profile: unknown, ...NOT_STATED }),
      ).toEqual({ ok: false, code: 'out_of_range' });
      expect(
        (
          await validateDraft(ctx, lineDraft(line.id, '200', { statedByMember: true }), {
            profile: unknown,
            recentUserTexts: ['200'],
          })
        ).ok,
      ).toBe(true);
    });

    it('limits a contribution to median income minus median spending', async () => {
      const ctx = await world();
      const profile = profileOf(); // 3000.00 income - 2000.00 spend = 1000.00 free
      expect(
        (
          await validateDraft(ctx, goalDraft({ monthlyContribution: '1000' }), {
            profile,
            ...NOT_STATED,
          })
        ).ok,
      ).toBe(true);
      expect(
        await validateDraft(ctx, goalDraft({ monthlyContribution: '1000.01' }), {
          profile,
          ...NOT_STATED,
        }),
      ).toEqual({ ok: false, code: 'out_of_range' });
      expect(
        (
          await validateDraft(
            ctx,
            goalDraft({ monthlyContribution: '1500', statedByMember: true }),
            { profile, recentUserTexts: ['1500 por mes'] },
          )
        ).ok,
      ).toBe(true);
    });

    it('reports unknown targets and unreadable amounts', async () => {
      const ctx = await world();
      const missing = '00000000-0000-4000-8000-000000000000';
      const update = proposalDraftSchema.parse({
        kind: 'goal_update',
        goalId: missing,
        targetAmount: '100',
        statedByMember: false,
        reason: 'r',
      });
      expect(await validateDraft(ctx, update, { profile: profileOf(), ...NOT_STATED })).toEqual({
        ok: false,
        code: 'not_found',
      });
      expect(
        await validateDraft(ctx, lineDraft(missing, '10'), { profile: profileOf(), ...NOT_STATED }),
      ).toEqual({ ok: false, code: 'not_found' });
      expect(
        await validateDraft(ctx, goalDraft({ targetAmount: '12,5' }), {
          profile: profileOf(),
          ...NOT_STATED,
        }),
      ).toEqual({ ok: false, code: 'invalid' });
    });

    it('rejects a month outside the budget year of the line', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      expect(
        await validateDraft(ctx, lineDraft(line.id, '200', { fromMonth: '2027-01' }), {
          profile,
          ...NOT_STATED,
        }),
      ).toEqual({ ok: false, code: 'invalid' });
    });
  });

  describe('proposalDraftSchema', () => {
    it('requires the reason and its limit', () => {
      const base = { kind: 'goal_create', name: 'Trip', statedByMember: false };
      expect(proposalDraftSchema.safeParse({ ...base, reason: 'x'.repeat(300) }).success).toBe(
        true,
      );
      expect(proposalDraftSchema.safeParse({ ...base, reason: 'x'.repeat(301) }).success).toBe(
        false,
      );
      expect(proposalDraftSchema.safeParse(base).success).toBe(false);
    });
  });

  describe('applyProposal', () => {
    it('applies a goal once under concurrent clicks', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ targetAmount: '5000' }));
      const results = await Promise.allSettled([
        applyProposal(ctx, p.id, { profile: profileOf() }),
        applyProposal(ctx, p.id, { profile: profileOf() }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.filter((r) => r.status === 'rejected');
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      expect(await listGoals(ctx)).toHaveLength(1);
      const after = await getProposal(ctx, p.id);
      expect(after.status).toBe('applied');
      expect(after.resolvedAt).toBeInstanceOf(Date);
    });

    it('creates the goal with the parsed amounts', async () => {
      const ctx = await world();
      const p = await propose(
        ctx,
        goalDraft({
          targetAmount: '5000.50',
          targetDate: '2027-06-30',
          monthlyContribution: '100',
        }),
      );
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).resolves.toBe('applied');
      const [g] = await listGoals(ctx);
      expect(g).toMatchObject({
        name: 'Trip',
        kind: 'generic',
        targetAmount: 500_050,
        targetDate: '2027-06-30',
        monthlyContribution: 10_000,
      });
    });

    it('updates a goal', async () => {
      const ctx = await world();
      const g = await createGoal(ctx, { name: 'Car', targetAmount: 100_000 });
      const p = await propose(ctx, {
        kind: 'goal_update',
        goalId: g.id,
        targetAmount: '2000',
        statedByMember: false,
        reason: 'r',
      });
      await applyProposal(ctx, p.id, { profile: profileOf() });
      expect((await listGoals(ctx))[0]).toMatchObject({ id: g.id, targetAmount: 200_000 });
    });

    it('marks a proposal stale when the goal changed after it', async () => {
      const ctx = await world();
      const g = await createGoal(ctx, { name: 'Car', targetAmount: 100_000 });
      const p = await propose(ctx, {
        kind: 'goal_update',
        goalId: g.id,
        targetAmount: '2000',
        statedByMember: false,
        reason: 'r',
      });
      await updateGoal(ctx, g.id, { targetAmount: 150_000 });
      const err = await applyProposal(ctx, p.id, { profile: profileOf() }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('stale');
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
      expect((await listGoals(ctx))[0]).toMatchObject({ targetAmount: 150_000 });
    });

    it('marks a proposal stale when its goal is gone', async () => {
      const ctx = await world();
      const g = await createGoal(ctx, { name: 'Car', targetAmount: 100_000 });
      const p = await propose(ctx, {
        kind: 'goal_update',
        goalId: g.id,
        targetAmount: '2000',
        statedByMember: false,
        reason: 'r',
      });
      await t.owner.delete(schema.goal).where(eq(schema.goal.id, g.id));
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toMatchObject({
        code: 'stale',
      });
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
    });

    it('sets a budget line from the chosen month on and keeps earlier months', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215.50'), profile);
      await applyProposal(ctx, p.id, { profile });
      const amounts = (await getBudgetLine(ctx, line.id)).amounts;
      expect(amounts.slice(0, 5)).toEqual([20_000, 20_000, 20_000, 20_000, 20_000]);
      expect(amounts.slice(5)).toEqual(Array.from({ length: 7 }, () => 21_550));
    });

    it('marks a line proposal stale when the line changed after it', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215'), profile);
      await upsertBudgetLine(ctx, line.budgetId, {
        id: line.id,
        kind: 'expense',
        name: 'Eating out',
      });
      await expect(applyProposal(ctx, p.id, { profile })).rejects.toMatchObject({ code: 'stale' });
      expect((await getBudgetLine(ctx, line.id)).amounts[6]).toBe(20_000);
    });

    it('marks a line proposal stale when only its amounts were edited', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215'), profile);
      const edited = Array.from({ length: 12 }, () => 20_000);
      edited[8] = 25_000; // September, inside the affected months
      await setLineAmounts(ctx, line.id, edited);
      const err = await applyProposal(ctx, p.id, { profile }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('stale');
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
      expect((await getBudgetLine(ctx, line.id)).amounts[8]).toBe(25_000);
    });

    it('ignores edits to months before the proposal starts', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215'), profile);
      const edited = Array.from({ length: 12 }, () => 20_000);
      edited[0] = 1;
      await setLineAmounts(ctx, line.id, edited);
      await expect(applyProposal(ctx, p.id, { profile })).resolves.toBe('applied');
    });

    it('marks a proposal stale when its stored payload no longer parses', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await t.owner
        .update(schema.advisorProposal)
        .set({ payload: { kind: 'goal_create' } })
        .where(eq(schema.advisorProposal.id, p.id));
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
    });

    it('marks a proposal stale when a rule category vanished', async () => {
      const ctx = await world();
      const group = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
      const cat = await createCategory(ctx, { groupId: group.id, name: 'Restaurants' });
      const p = await propose(ctx, {
        kind: 'rule_create',
        name: 'Cafe',
        categoryId: cat.id,
        condition: { descriptionContains: 'cafe' },
        statedByMember: false,
        reason: 'r',
      });
      await t.owner.delete(schema.category).where(eq(schema.category.id, cat.id));
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
    });

    it('re-validates at apply: budget amounts are refused while learning', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215'), profile);
      const learning = { ...profile, learning: { ready: false, completeMonths: 1, required: 3 } };
      await expect(applyProposal(ctx, p.id, { profile: learning })).rejects.toMatchObject({
        code: 'learning',
      });
      // Nothing was spent: the member can still apply once learning is over.
      expect((await getProposal(ctx, p.id)).status).toBe('pending');
      await expect(applyProposal(ctx, p.id, { profile })).resolves.toBe('applied');
    });

    it('re-validates at apply: an amount the member never stated is refused', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      const p = await propose(ctx, lineDraft(line.id, '215'), profile);
      const tighter = {
        ...profile,
        budgetLines: [{ ...profile.budgetLines[0]!, typical: typical(30_000, 28_000, 32_000) }],
      };
      await expect(applyProposal(ctx, p.id, { profile: tighter })).rejects.toMatchObject({
        code: 'out_of_range',
      });
      expect((await getProposal(ctx, p.id)).status).toBe('pending');
    });

    it('lets a stated out-of-range amount through at apply, from the member messages', async () => {
      const ctx = await world();
      const { line, profile } = await lineWorld(ctx);
      await appendMessage(ctx, {
        role: 'user',
        origin: 'chat',
        text: 'quero 300 € para restaurantes',
      });
      const p = await propose(ctx, lineDraft(line.id, '300', { statedByMember: true }), profile, [
        'quero 300 € para restaurantes',
      ]);
      await expect(applyProposal(ctx, p.id, { profile })).resolves.toBe('applied');
    });

    it('returns to pending when the service fails', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ goalKind: 'emergency_fund' }));
      // Another fund appears after the proposal: the goal service refuses the second one.
      await createGoal(ctx, { name: 'Buffer', kind: 'emergency_fund' });
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toMatchObject({
        code: 'emergency_fund_exists',
      });
      const after = await getProposal(ctx, p.id);
      expect(after.status).toBe('pending');
      expect(after.resolvedAt).toBeNull();
      expect(await listGoals(ctx)).toHaveLength(1);
    });

    it('marks a proposal stale when its linked account vanished', async () => {
      const ctx = await world();
      const acc = await createAccount(ctx, { name: 'Pot', type: 'savings' });
      const p = await propose(ctx, goalDraft({ accountId: acc.id }));
      await t.owner.delete(schema.financialAccount).where(eq(schema.financialAccount.id, acc.id));
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await getProposal(ctx, p.id)).status).toBe('stale');
    });

    it('forbids viewers from applying', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await expect(
        applyProposal(withRole(ctx, 'viewer'), p.id, { profile: profileOf() }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect((await getProposal(ctx, p.id)).status).toBe('pending');
    });

    it('does not apply another member proposal', async () => {
      const ctx = await world();
      const other = { ...ctx, userId: (await world()).userId };
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await expect(applyProposal(other, p.id, { profile: profileOf() })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('creates a rule and categorises a transaction', async () => {
      const ctx = await world();
      const group = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
      const cat = await createCategory(ctx, { groupId: group.id, name: 'Restaurants' });
      const acc = await createAccount(ctx, { name: 'Main', type: 'checking' });
      const [tx1] = await t.owner
        .insert(schema.transaction)
        .values({
          householdId: ctx.householdId,
          accountId: acc.id,
          dedupeHash: `p${randomUUID()}`,
          bookingDate: '2026-05-02',
          amount: -1200,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'Example Cafe',
          source: 'manual',
        })
        .returning();
      const rule = await propose(ctx, {
        kind: 'rule_create',
        name: 'Cafe',
        categoryId: cat.id,
        condition: { descriptionContains: 'cafe' },
        statedByMember: false,
        reason: 'r',
      });
      await applyProposal(ctx, rule.id, { profile: profileOf() });
      expect((await listRules(ctx)).map((r) => r.name)).toEqual(['Cafe']);

      const cat2 = await propose(ctx, {
        kind: 'transaction_categorise',
        transactionId: tx1!.id,
        categoryId: cat.id,
        applyToMerchant: false,
        statedByMember: false,
        reason: 'r',
      });
      await applyProposal(ctx, cat2.id, { profile: profileOf() });
      const [row] = await t.owner
        .select({ categoryId: schema.transaction.categoryId })
        .from(schema.transaction)
        .where(eq(schema.transaction.id, tx1!.id));
      expect(row!.categoryId).toBe(cat.id);
    });

    it('writes an audit row advisor.apply.goal_create', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await applyProposal(ctx, p.id, { profile: profileOf() });
      const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.householdId, ctx.householdId),
              eq(auditLog.action, 'advisor.apply.goal_create'),
            ),
          ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor: 'web',
        userId: ctx.userId,
        targetType: 'goal',
        targetId: (await listGoals(ctx))[0]!.id,
      });
    });
  });

  describe('recentUserTexts', () => {
    it('returns the member user messages up to a point in time, newest first, capped', async () => {
      const ctx = await world();
      const other = { ...ctx, userId: (await world()).userId };
      for (const text of ['one', 'two', 'three']) {
        await appendMessage(ctx, { role: 'user', origin: 'chat', text });
      }
      await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: 'reply' });
      await appendMessage(other, { role: 'user', origin: 'chat', text: 'theirs' });
      expect(await recentUserTexts(ctx, {})).toEqual(['three', 'two', 'one']);
      expect(await recentUserTexts(ctx, { limit: 2 })).toEqual(['three', 'two']);
      expect(await recentUserTexts(ctx, { upTo: new Date(0) })).toEqual([]);
    });
  });

  describe('dismissProposal', () => {
    it('dismisses a pending proposal and keeps the data untouched', async () => {
      const ctx = await world();
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await dismissProposal(ctx, p.id);
      const after = await getProposal(ctx, p.id);
      expect(after.status).toBe('dismissed');
      expect(after.resolvedAt).toBeInstanceOf(Date);
      expect(await listGoals(ctx)).toHaveLength(0);
      await expect(applyProposal(ctx, p.id, { profile: profileOf() })).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('does not touch another member proposal', async () => {
      const ctx = await world();
      const other = { ...ctx, userId: (await world()).userId };
      const p = await propose(ctx, goalDraft({ targetAmount: '100' }));
      await expect(dismissProposal(other, p.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
