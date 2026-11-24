import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  appendMessage,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  createGoal,
  getProposal,
  listMessages,
  saveProposal,
  setLineAmounts,
  upsertBudgetLine,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

describe('advisor proposal display', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world(): Promise<ServiceCtx> {
    const base = await t.household({ currency: 'EUR' });
    const id = `u_${randomUUID()}`;
    await t.owner
      .insert(schema.user)
      .values({ id, name: 'Member', email: `${id}@example.com`, createdAt: new Date() });
    return { ...base, userId: id };
  }

  /** Stores a proposal the way the tool does and returns it with the message it hangs from. */
  async function store(ctx: ServiceCtx, kind: schema.AdvisorProposalKind, payload: object) {
    const msg = await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: 'ok' });
    const saved = await saveProposal(ctx, {
      messageId: msg!.id,
      kind,
      payload: { kind, statedByMember: false, reason: 'r', ...payload },
      basis: null,
      targetUpdatedAt: null,
    });
    return { saved, messageId: msg!.id };
  }

  it('names the goal a goal update changes', async () => {
    const ctx = await world();
    const goal = await createGoal(ctx, { name: 'Holiday', targetAmount: 100_000 });
    const { saved } = await store(ctx, 'goal_update', { goalId: goal.id, targetAmount: '2000' });
    expect(saved.display).toEqual({ goalName: 'Holiday' });
  });

  it('names the budget line and the last month the new amount covers', async () => {
    const ctx = await world();
    const budget = await createBudget(ctx, { startMonth: '2026-01-01' });
    const line = await upsertBudgetLine(ctx, budget.id, { kind: 'expense', name: 'Restaurants' });
    await setLineAmounts(
      ctx,
      line.id,
      Array.from({ length: 12 }, () => 20_000),
    );
    const { saved } = await store(ctx, 'budget_line_amount', {
      lineId: line.id,
      monthlyAmount: '250',
      fromMonth: '2026-06',
    });
    expect(saved.display).toEqual({ lineName: 'Restaurants', toMonth: '2026-12' });
  });

  it('names the category and the accounts of a rule', async () => {
    const ctx = await world();
    const group = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
    const cat = await createCategory(ctx, { groupId: group.id, name: 'Restaurants' });
    const acc = await createAccount(ctx, { name: 'Main account', type: 'checking' });
    const { saved } = await store(ctx, 'rule_create', {
      name: 'Cafe',
      categoryId: cat.id,
      condition: { descriptionContains: 'cafe', accountIds: [acc.id] },
    });
    expect(saved.display).toEqual({ categoryName: 'Restaurants', accountNames: ['Main account'] });
  });

  it('shows the transaction with a redacted description and the target category', async () => {
    const ctx = await world();
    const group = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
    const cat = await createCategory(ctx, { groupId: group.id, name: 'Restaurants' });
    const acc = await createAccount(ctx, { name: 'Main', type: 'checking' });
    const [row] = await t.owner
      .insert(schema.transaction)
      .values({
        householdId: ctx.householdId,
        accountId: acc.id,
        dedupeHash: `p${randomUUID()}`,
        bookingDate: '2026-05-02',
        amount: -1200,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'Example Cafe 123456789012',
        source: 'manual',
      })
      .returning();
    const { saved, messageId } = await store(ctx, 'transaction_categorise', {
      transactionId: row!.id,
      categoryId: cat.id,
      applyToMerchant: true,
    });
    const expected = {
      categoryName: 'Restaurants',
      transaction: {
        bookedOn: row!.purchaseDate,
        amount: -1200,
        currency: 'EUR',
        description: 'Example Cafe #',
      },
    };
    expect(saved.display).toEqual(expected);
    expect((await getProposal(ctx, saved.id)).display).toEqual(expected);
    const [message] = await listMessages(ctx, {});
    expect(message!.id).toBe(messageId);
    expect(message!.proposals[0]!.display).toEqual(expected);
  });

  it('is null when the target is gone or the kind needs nothing resolved', async () => {
    const ctx = await world();
    const gone = await store(ctx, 'goal_update', { goalId: randomUUID(), targetAmount: '10' });
    expect(gone.saved.display).toBeNull();
    const create = await store(ctx, 'goal_create', { name: 'Trip' });
    expect(create.saved.display).toBeNull();
  });
});
