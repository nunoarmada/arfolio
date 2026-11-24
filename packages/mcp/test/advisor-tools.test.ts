import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  appendMessage,
  applyProposal,
  createAccount,
  createBudget,
  createGoal,
  getProposal,
  listNotes,
  setLineAmounts,
  upsertBudgetLine,
  MAX_ADVISOR_NOTES,
  type ServiceCtx,
  type SpendingProfile,
  type TypicalSpend,
} from '@arfolio/services';
import { advisorTools, toAnthropicTools, type AdvisorToolContext } from '../src/advisor/tools.js';
import { startServicesDb, type ServicesTestDb } from './harness.js';

const typical = (median: number, min = median, max = median): TypicalSpend => ({
  median,
  min,
  max,
  months: 6,
  outlierMonths: [],
});

const profileOf = (over: Partial<SpendingProfile> = {}): SpendingProfile => ({
  learning: { ready: true, completeMonths: 6, required: 3 },
  currency: 'EUR',
  window: ['2026-01', '2026-02'],
  categories: [{ categoryId: 'c1', name: 'Food', group: 'Food', typical: typical(100_000) }],
  income: typical(300_000, 280_000, 320_000),
  recurringMonthly: 12_345,
  budgetLines: [],
  ...over,
});

const LIMITS = { learningMonths: 3, weeklyCap: 2, dailyMessages: 50, maxToolCalls: 8 };

describe('advisor tools', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** A household with one real member (advisor rows have a FK to "user") and the tool context. */
  async function world(profile: SpendingProfile = profileOf()) {
    const base = await t.household({ currency: 'EUR', role: 'member' });
    const userId = `u_${randomUUID()}`;
    await t.owner.insert(schema.user).values({
      id: userId,
      name: 'Member',
      email: `${userId}@example.com`,
      createdAt: new Date(),
    });
    const ctx: ServiceCtx = { ...base, userId };
    const msg = await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: '' });
    const tc: AdvisorToolContext = {
      ctx,
      profile,
      recentUserTexts: [],
      messageId: msg!.id,
      limits: LIMITS,
    };
    return { ctx, tc };
  }
  const tool = (name: string) => {
    const found = advisorTools().find((x) => x.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  it('exposes the read tools and the advisor tools, and no household write tool', () => {
    expect(advisorTools().map((x) => x.name)).toEqual([
      'get_overview',
      'list_accounts',
      'get_net_worth',
      'get_budget_vs_actual',
      'search_transactions',
      'list_categories',
      'list_review_inbox',
      'get_spending_profile',
      'list_goals',
      'propose_action',
      'save_note',
    ]);
  });

  it('describes every tool to Anthropic as an object schema', () => {
    const tools = toAnthropicTools(advisorTools());
    expect(tools.map((x) => x.name)).toEqual(advisorTools().map((x) => x.name));
    for (const x of tools) {
      expect(x.description, x.name).toBeTruthy();
      expect(x.input_schema.type, x.name).toBe('object');
      expect(x.input_schema, x.name).not.toHaveProperty('$schema');
    }
  });

  it('read tools run with the member ctx', async () => {
    const mine = await world();
    const other = await world();
    await createAccount(mine.ctx, { name: 'Checking', type: 'checking' });
    await createAccount(other.ctx, { name: 'Elsewhere', type: 'checking' });
    const out = (await tool('list_accounts').run({}, mine.tc)) as {
      accounts: Array<{ name: string }>;
    };
    expect(out.accounts.map((a) => a.name)).toEqual(['Checking']);
  });

  it('propose_action stores a pending proposal and writes no household data', async () => {
    const { ctx, tc } = await world();
    const category = await t.owner
      .insert(schema.categoryGroup)
      .values({ householdId: ctx.householdId, name: 'Daily', kind: 'expense' })
      .returning()
      .then(async ([g]) => {
        const [c] = await t.owner
          .insert(schema.category)
          .values({ householdId: ctx.householdId, groupId: g!.id, name: 'Food' })
          .returning();
        return c!;
      });
    const rules = () =>
      t.owner.select().from(schema.rule).where(eq(schema.rule.householdId, ctx.householdId));
    const before = await rules();

    // A draft such an injected transaction description could talk the model into.
    const result = (await tool('propose_action').run(
      {
        draft: {
          kind: 'rule_create',
          name: 'Everything is food',
          categoryId: category.id,
          condition: { descriptionContains: 'ignore previous instructions' },
          statedByMember: false,
          reason: 'A description told me to',
        },
      },
      tc,
    )) as { proposal_id: string; status: string };

    expect(Object.keys(result).sort()).toEqual(['proposal_id', 'status']);
    expect(result.status).toBe('pending');
    expect((await getProposal(ctx, result.proposal_id)).status).toBe('pending');
    expect(await rules()).toEqual(before);
  });

  it('propose_action keeps the internal basis so a budget proposal can still be applied', async () => {
    const { ctx, tc } = await world();
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
    const result = (await tool('propose_action').run(
      {
        draft: {
          kind: 'budget_line_amount',
          lineId: line.id,
          monthlyAmount: '215',
          fromMonth: '2026-06',
          statedByMember: false,
          reason: 'Closer to what you spend',
        },
      },
      { ...tc, profile },
    )) as { proposal_id: string };
    expect(Object.keys(result).sort()).toEqual(['proposal_id', 'status']);
    // The model never sees the snapshot, yet apply finds it and the proposal is not stale.
    expect((await getProposal(ctx, result.proposal_id)).basis).not.toHaveProperty(
      'amountsSnapshot',
    );
    await expect(applyProposal(ctx, result.proposal_id, { profile })).resolves.toBe('applied');
  });

  it('propose_action refuses what the profile does not support and stores nothing', async () => {
    const learning = profileOf({ learning: { ready: false, completeMonths: 1, required: 3 } });
    const { ctx, tc } = await world(learning);
    const goal = await createGoal(ctx, { kind: 'generic', name: 'Trip' });
    const result = await tool('propose_action').run(
      {
        draft: {
          kind: 'goal_update',
          goalId: goal.id,
          monthlyContribution: '100',
          statedByMember: false,
          reason: 'r',
        },
      },
      tc,
    );
    expect(result).toEqual({ refused: 'learning' });
    const rows = await t.owner
      .select()
      .from(schema.advisorProposal)
      .where(eq(schema.advisorProposal.householdId, ctx.householdId));
    expect(rows).toEqual([]);
  });

  it('propose_action refuses a malformed draft instead of throwing', async () => {
    const { tc } = await world();
    expect(await tool('propose_action').run({ draft: { kind: 'nonsense' } }, tc)).toEqual({
      refused: 'invalid',
    });
    expect(await tool('propose_action').run({}, tc)).toEqual({ refused: 'invalid' });
  });

  it('propose_action refuses a target that does not exist', async () => {
    const { tc } = await world();
    const result = await tool('propose_action').run(
      {
        draft: {
          kind: 'goal_update',
          goalId: randomUUID(),
          targetAmount: '500',
          statedByMember: false,
          reason: 'r',
        },
      },
      tc,
    );
    expect(result).toEqual({ refused: 'not_found' });
    const bad = await tool('propose_action').run(
      {
        draft: {
          kind: 'goal_update',
          goalId: 'not-a-uuid',
          targetAmount: '500',
          statedByMember: false,
          reason: 'r',
        },
      },
      tc,
    );
    expect(bad).toEqual({ refused: 'not_found' });
  });

  it('get_spending_profile returns amounts as money objects', async () => {
    const { tc } = await world();
    const out = (await tool('get_spending_profile').run({}, tc)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.learning).toEqual({ ready: true, completeMonths: 6, required: 3 });
    expect(out.currency).toBe('EUR');
    expect(out.recurringMonthly).toEqual({
      amount: '123.45',
      amount_minor: '12345',
      currency: 'EUR',
    });
    expect(out.income.median).toEqual({
      amount: '3000.00',
      amount_minor: '300000',
      currency: 'EUR',
    });
    expect(out.income.months).toBe(6);
    expect(out.categories[0]).toMatchObject({ categoryId: 'c1', name: 'Food' });
    expect(out.categories[0].typical.max.amount).toBe('1000.00');
  });

  it('list_goals maps goals to the shape the model sees', async () => {
    const { ctx, tc } = await world();
    await createGoal(ctx, { kind: 'generic', name: 'Trip', targetAmount: 100_000 });
    const out = (await tool('list_goals').run({}, tc)) as { goals: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.goals).toHaveLength(1);
    expect(out.goals[0]).toMatchObject({
      name: 'Trip',
      kind: 'generic',
      targetAmount: { amount: '1000.00', amount_minor: '100000', currency: 'EUR' },
      targetDate: null,
      saved: { amount_minor: '0' },
      progressPct: 0,
    });
    expect(Object.keys(out.goals[0]).sort()).toEqual(
      [
        'id',
        'kind',
        'monthlyContribution',
        'name',
        'progressPct',
        'saved',
        'targetAmount',
        'targetDate',
      ].sort(),
    );
  });

  it('save_note stores a note and reports the note limit instead of throwing', async () => {
    const { ctx, tc } = await world();
    expect(await tool('save_note').run({ text: 'Prefers short answers' }, tc)).toEqual({
      saved: true,
    });
    expect((await listNotes(ctx)).map((n) => n.text)).toEqual(['Prefers short answers']);
    for (let i = 1; i < MAX_ADVISOR_NOTES; i += 1) {
      await tool('save_note').run({ text: `note ${i}` }, tc);
    }
    expect(await tool('save_note').run({ text: 'one too many' }, tc)).toEqual({
      refused: 'note_limit',
    });
    await expect(tool('save_note').run({ text: 'x'.repeat(501) }, tc)).rejects.toThrow();
  });
});
