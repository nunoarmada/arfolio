import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import {
  aiCategorise,
  categoriseTransaction,
  createAccount,
  createCategory,
  createCategoryGroup,
  findHouseholdsWithAiWork,
  ingestTransactions,
  undoAiCategorisation,
  createRule,
  listCategories,
  seedCategoryTemplates,
  type AiCategoriseDeps,
  type AnthropicLike,
  type ServiceCtx,
} from '../../src/index.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';

type Call = Parameters<AnthropicLike['messages']['parse']>[0];
type Item = { id: string; categoryId: string | null; confidence: number };
type PromptRow = {
  id: string;
  description: string;
  counterparty: string | null;
  amount: string;
  date: string;
};

const rowsOf = (call: Call): PromptRow[] =>
  (JSON.parse(call.messages[0]!.content) as { transactions: PromptRow[] }).transactions;
const categoriesOf = (call: Call): Array<{ id: string; name: string; kind: string }> =>
  JSON.parse(
    call.system
      .map((b) => b.text)
      .join('\n')
      .split('Categories:\n')[1]!,
  );

describe('aiCategorise', () => {
  let t: ServicesTestDb;
  let ctx: ServiceCtx;
  let off: ServiceCtx;
  let accountId: string;
  let offAccountId: string;
  let food: string;
  let fun: string;
  let transferCat: string;
  let other: string;
  let otherIncome: string;
  let calls: Call[];
  let seq = 0;

  const log = { info: () => {}, warn: () => {} };
  const deps = (
    respond: (call: Call, n: number) => Promise<unknown> | unknown,
    over: Partial<AiCategoriseDeps> = {},
  ): AiCategoriseDeps => ({
    db: ctx.db,
    anthropic: {
      messages: {
        async parse(params: Call) {
          calls.push(params);
          const out = await respond(params, calls.length - 1);
          return {
            parsed_output: out,
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      },
    },
    model: 'test-model',
    logger: log,
    ...over,
  });
  /** Answers every row of the call with the category chosen by `pick(row)`. */
  const answer =
    (pick: (row: PromptRow) => [string | null, number]) =>
    (call: Call): { items: Item[] } => ({
      items: rowsOf(call).map((r) => {
        const [categoryId, confidence] = pick(r);
        return { id: r.id, categoryId, confidence };
      }),
    });

  /** An account linked to an active Trading 212 connection. */
  async function t212Account(household = ctx): Promise<string> {
    const id = (await createAccount(household, { name: 'T212', type: 'investment' })).id;
    const [conn] = await t.owner
      .insert(schema.connection)
      .values({
        householdId: household.householdId,
        provider: 'trading212',
        displayName: 'T212',
        status: 'active',
        createdBy: 'user-1',
      })
      .returning({ id: schema.connection.id });
    await t.owner.insert(schema.connectionAccount).values({
      householdId: household.householdId,
      connectionId: conn!.id,
      accountId: id,
      externalUid: '1',
      externalKey: `k${id}`,
      currency: 'EUR',
      name: 'T212',
    });
    return id;
  }
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  const refOf = (call: Call, name: string) => categoriesOf(call).find((c) => c.name === name)!.id;

  async function insertTx(
    over: Partial<typeof schema.transaction.$inferInsert> = {},
    household = ctx,
  ): Promise<string> {
    seq += 1;
    const [row] = await t.owner
      .insert(schema.transaction)
      .values({
        householdId: household.householdId,
        accountId,
        dedupeHash: `h${seq}`,
        bookingDate: '2026-10-05',
        amount: -1_250,
        currency: 'EUR',
        status: 'booked',
        rawDescription: `SHOP ${seq}`,
        source: 'connector',
        needsReview: true,
        ...over,
      })
      .returning({ id: schema.transaction.id });
    return row!.id;
  }
  const stored = async (id: string) =>
    (await t.owner.select().from(schema.transaction).where(eq(schema.transaction.id, id)))[0]!;

  beforeAll(async () => {
    t = await startServicesDb();
    ctx = await t.household({ locale: 'en' });
    off = await t.household();
    await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx
        .update(schema.householdSettings)
        .set({ aiEnabled: true })
        .where(eq(schema.householdSettings.householdId, ctx.householdId)),
    );
    await seedCategoryTemplates(ctx, 'en');
    const group = await createCategoryGroup(ctx, { name: 'Daily', kind: 'expense' });
    food = (await createCategory(ctx, { groupId: group.id, name: 'Food' })).id;
    fun = (await createCategory(ctx, { groupId: group.id, name: 'Fun' })).id;
    const archivedGroup = await createCategoryGroup(ctx, { name: 'Old', kind: 'expense' });
    await createCategory(ctx, { groupId: archivedGroup.id, name: 'Archived cat' });
    await t.owner
      .update(schema.category)
      .set({ archivedAt: new Date() })
      .where(eq(schema.category.name, 'Archived cat'));
    transferCat = (await listCategories(ctx))
      .flatMap((g) => g.categories)
      .find((c) => c.templateKey === 'transfer.between_accounts')!.id;
    const all = (await listCategories(ctx)).flatMap((g) => g.categories);
    other = all.find((c) => c.templateKey === 'leisure.other')!.id;
    otherIncome = all.find((c) => c.templateKey === 'income.other')!.id;
    accountId = (await createAccount(ctx, { name: 'Secret Account Name', type: 'checking' })).id;
    offAccountId = (await createAccount(off, { name: 'Other', type: 'checking' })).id;
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    calls = [];
    // Each test starts from an empty review queue.
    await t.owner
      .delete(schema.transaction)
      .where(inArray(schema.transaction.householdId, [ctx.householdId, off.householdId]));
  });

  it('leaves recent Trading 212 card rows without a merchant for the export, and judges them once it is old', async () => {
    await t.owner
      .insert(schema.user)
      .values({ id: 'user-1', name: 'u', email: 'u@example.test' })
      .onConflictDoNothing();
    const t212 = await t212Account();
    const fresh = await insertTx({
      accountId: t212,
      rawDescription: 'WITHDRAW abc123',
      bookingDate: daysAgo(2),
    });
    const named = await insertTx({
      accountId: t212,
      rawDescription: 'Cafe Lisboa',
      counterparty: 'Cafe Lisboa',
      bookingDate: daysAgo(2),
    });
    const old = await insertTx({
      accountId: t212,
      rawDescription: 'WITHDRAW old999',
      bookingDate: daysAgo(45),
    });
    const bank = await insertTx({ rawDescription: 'WITHDRAW bank1', bookingDate: daysAgo(2) });
    await aiCategorise(deps(answer(() => [null, 0])), { householdId: ctx.householdId });
    const asked = rowsOf(calls[0]!).map((r) => r.description);
    expect(asked.sort()).toEqual(['Cafe Lisboa', 'WITHDRAW bank1', 'WITHDRAW old999']);
    expect((await stored(fresh)).aiAttempts).toBe(0);
    expect((await stored(named)).aiAttempts).toBe(1);
    expect((await stored(old)).aiAttempts).toBe(1);
    expect((await stored(bank)).aiAttempts).toBe(1);
  });

  it('applies every answer: high confidence leaves review, the rest stays in review', async () => {
    const hi = await insertTx({ rawDescription: 'HI' });
    const mid = await insertTx({ rawDescription: 'MID' });
    const low = await insertTx({ rawDescription: 'LOW' });
    const result = await aiCategorise(
      deps((call) =>
        answer((r) => {
          const id = refOf(call, 'Food');
          if (r.description === 'HI') return [id, 0.85];
          if (r.description === 'MID') return [id, 0.84];
          return [id, 0.2];
        })(call),
      ),
      { householdId: ctx.householdId },
    );
    expect(result).toMatchObject({
      applied: 1,
      review: 2,
      fallback: 0,
      skipped: 0,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(await stored(hi)).toMatchObject({
      categoryId: food,
      categorisedBy: 'ai',
      needsReview: false,
      confidence: 0.85,
      aiAttempts: 1,
    });
    expect(await stored(mid)).toMatchObject({
      categoryId: food,
      categorisedBy: 'ai',
      aiConfidence: expect.closeTo(0.84),
      needsReview: true,
      aiAttempts: 1,
    });
    expect(await stored(low)).toMatchObject({
      categoryId: food,
      categorisedBy: 'ai',
      aiConfidence: expect.closeTo(0.2),
      needsReview: true,
      aiAttempts: 1,
    });
  });

  it('retries a row without a usable answer, and gives up after three attempts', async () => {
    const id = await insertTx({ rawDescription: 'HARD' });
    const none = () => ({ items: [] });
    for (const attempts of [1, 2]) {
      await aiCategorise(deps(none), { householdId: ctx.householdId });
      expect(await stored(id)).toMatchObject({
        categoryId: null,
        aiAttempts: attempts,
        needsReview: true,
      });
    }
    expect(calls).toHaveLength(2);
    const third = await aiCategorise(deps(none), { householdId: ctx.householdId });
    expect(calls).toHaveLength(3);
    expect(third).toMatchObject({ applied: 0, review: 0, fallback: 1 });
    await aiCategorise(deps(none), { householdId: ctx.householdId });
    expect(calls).toHaveLength(3);
    expect(await stored(id)).toMatchObject({ aiAttempts: 3, categoryId: other });
  });

  it('adds the merchant category code and its label when the provider sent one', async () => {
    await insertTx({ rawDescription: 'WITH MCC', mcc: '5411' });
    await insertTx({ rawDescription: 'NO MCC' });
    await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId },
    );
    const rows = rowsOf(calls[0]!) as Array<PromptRow & { mcc?: string; mccLabel?: string }>;
    const withMcc = rows.find((r) => r.description === 'WITH MCC')!;
    expect(withMcc.mcc).toBe('5411');
    expect(withMcc.mccLabel).toEqual(expect.any(String));
    const without = rows.find((r) => r.description === 'NO MCC')!;
    expect(without).not.toHaveProperty('mcc');
    expect(without).not.toHaveProperty('mccLabel');
  });

  it('sends only the allowed fields, with short ids and redacted text', async () => {
    await insertTx({
      rawDescription: 'TRF PT50000201231234567890154 CONTINENTE 123',
      counterparty: 'maria@example.com',
      amount: -1_234,
      bookingDate: '2026-10-05',
      notes: 'private note',
    });
    await insertTx({ rawDescription: 'SALARY', amount: 150_000, currency: 'EUR' });
    await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId },
    );
    const call = calls[0]!;
    const rows = rowsOf(call);
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    const spend = rows.find((r) => r.description.startsWith('TRF'))!;
    expect(spend).toEqual({
      id: spend.id,
      description: 'TRF # CONTINENTE 123',
      counterparty: '#',
      amount: '-12.34 EUR',
      date: '2026-10',
    });
    expect(rows.find((r) => r.description === 'SALARY')!.amount).toBe('1500.00 EUR');
    const everything = JSON.stringify(call);
    for (const secret of [
      'Secret Account Name',
      'private note',
      'Test household',
      'user-1',
      'PT5000',
      ctx.householdId,
      accountId,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(call.model).toBe('test-model');
  });

  it('puts the static prompt and category list in cacheable system blocks', async () => {
    await insertTx();
    await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId },
    );
    const system = calls[0]!.system;
    expect(system.length).toBeGreaterThanOrEqual(2);
    expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    const names = categoriesOf(calls[0]!).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Food', 'Fun', 'Salary']));
    expect(names).not.toContain('Between accounts');
    expect(names).not.toContain('Archived cat');
    expect(JSON.stringify(system)).not.toContain(food);
  });

  it('only touches rows that are uncategorised, unedited, booked, not transfers and under three attempts', async () => {
    const eligible = await insertTx({ rawDescription: 'ELIGIBLE' });
    await insertTx({ rawDescription: 'CATEGORISED', categoryId: food, needsReview: false });
    const settled = await insertTx({ rawDescription: 'NOT IN REVIEW', needsReview: false });
    const judged = await insertTx({ rawDescription: 'JUDGED BEFORE', aiConfidence: 0.3 });
    await insertTx({ rawDescription: 'SPENT', aiAttempts: 3 });
    await insertTx({ rawDescription: 'EDITED', userEditedAt: new Date() });
    await insertTx({ rawDescription: 'PENDING', status: 'pending' });
    await insertTx({
      rawDescription: 'TRANSFER',
      transferGroupId: '11111111-1111-4111-8111-111111111111',
    });
    await insertTx({ rawDescription: 'OTHER HOUSEHOLD', accountId: offAccountId }, off);
    const result = await aiCategorise(
      deps((call) => answer(() => [refOf(call, 'Food'), 0.95])(call)),
      { householdId: ctx.householdId },
    );
    expect(
      calls
        .flatMap(rowsOf)
        .map((r) => r.description)
        .sort(),
    ).toEqual(['ELIGIBLE', 'JUDGED BEFORE', 'NOT IN REVIEW']);
    expect(result.applied).toBe(3);
    for (const id of [eligible, settled, judged]) expect((await stored(id)).categoryId).toBe(food);
  });

  it('restricts the run to the given transaction ids', async () => {
    const one = await insertTx({ rawDescription: 'ONE' });
    await insertTx({ rawDescription: 'TWO' });
    await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId, transactionIds: [one, 'not-a-uuid'] },
    );
    expect(calls.flatMap(rowsOf).map((r) => r.description)).toEqual(['ONE']);
  });

  it('ignores unknown ids and categories, bad confidence and duplicates', async () => {
    const a = await insertTx({ rawDescription: 'A' });
    const b = await insertTx({ rawDescription: 'B' });
    const c = await insertTx({ rawDescription: 'C' });
    const d = await insertTx({ rawDescription: 'D' });
    const result = await aiCategorise(
      deps((call) => {
        const f = refOf(call, 'Food');
        const ids = Object.fromEntries(rowsOf(call).map((r) => [r.description, r.id]));
        return {
          items: [
            { id: 'ghost', categoryId: f, confidence: 0.99 },
            { id: ids.A, categoryId: 'c999', confidence: 0.99 },
            { id: ids.B, categoryId: f, confidence: 7 },
            { id: ids.B, categoryId: refOf(call, 'Fun'), confidence: 0.99 },
            { id: ids.C, categoryId: f, confidence: Number.NaN },
            { id: ids.D, categoryId: null, confidence: 0.99 },
          ],
        };
      }),
      { householdId: ctx.householdId },
    );
    expect(result).toMatchObject({ applied: 1, review: 0, skipped: 3 });
    expect((await stored(a)).categoryId).toBeNull();
    // Confidence above 1 is clamped, and the first answer for an id wins.
    expect(await stored(b)).toMatchObject({ categoryId: food, confidence: 1 });
    expect((await stored(c)).categoryId).toBeNull();
    expect((await stored(d)).categoryId).toBeNull();
  });

  it('tolerates a malformed, empty or refused answer and continues with the next batch', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 250; i += 1) ids.push(await insertTx({ rawDescription: `R${i}` }));
    const warnings: string[] = [];
    const result = await aiCategorise(
      deps(
        (call, n) => {
          if (n === 0) return null; // refusal or unparsable output
          if (n === 1) throw new Error('boom SECRET-DESCRIPTION');
          return answer(() => [refOf(call, 'Food'), 0.9])(call);
        },
        { logger: { info: () => {}, warn: (m) => warnings.push(m) } },
      ),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ applied: 50, skipped: 200 });
    expect(warnings.join(' ')).not.toContain('SECRET');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('batches 250 rows into three calls of at most 100', async () => {
    for (let i = 0; i < 250; i += 1) await insertTx({ rawDescription: `R${i}` });
    const result = await aiCategorise(
      deps((call) => answer(() => [refOf(call, 'Food'), 0.9])(call)),
      { householdId: ctx.householdId },
    );
    expect(calls.map((c) => rowsOf(c).length)).toEqual([100, 100, 50]);
    expect(result).toMatchObject({ applied: 250, inputTokens: 300, outputTokens: 30 });
  });

  it('works through every waiting row in passes, sending each row once per run', async () => {
    for (let i = 0; i < 12; i += 1) await insertTx({ rawDescription: `R${i}` });
    const result = await aiCategorise(
      deps(() => ({ items: [] }), { maxRowsPerRun: 5, batchSize: 2 }),
      { householdId: ctx.householdId },
    );
    expect(calls.map((c) => rowsOf(c).length)).toEqual([2, 2, 1, 2, 2, 1, 2]);
    const sent = calls.flatMap(rowsOf).map((r) => r.description);
    expect(new Set(sent).size).toBe(12);
    // Unanswered rows used one attempt each and wait for a later run.
    expect(result).toMatchObject({ status: 'done', applied: 0, fallback: 0, skipped: 12 });
  });

  it('stops after the pass limit and leaves the rest for the next run', async () => {
    for (let i = 0; i < 12; i += 1) await insertTx({ rawDescription: `R${i}` });
    await aiCategorise(
      deps((call) => answer(() => [refOf(call, 'Food'), 0.9])(call), {
        maxRowsPerRun: 5,
        batchSize: 5,
        maxPassesPerRun: 2,
      }),
      { householdId: ctx.householdId },
    );
    expect(calls.map((c) => rowsOf(c).length)).toEqual([5, 5]);
  });

  it('stops the run on a connection error or timeout without counting an attempt', async () => {
    for (const err of [
      new APIConnectionError({ message: 'reset' }),
      new APIConnectionTimeoutError(),
    ]) {
      calls = [];
      const id = await insertTx({ rawDescription: 'NET' });
      const result = await aiCategorise(
        deps(() => {
          throw err;
        }),
        { householdId: ctx.householdId },
      );
      expect(calls).toHaveLength(1);
      expect(result.status).toBe('rate_limited');
      expect(await stored(id)).toMatchObject({ aiAttempts: 0, categoryId: null });
    }
  });

  it('starts no new batch once the run has used its time', async () => {
    for (let i = 0; i < 12; i += 1) await insertTx({ rawDescription: `R${i}` });
    let now = 0;
    await aiCategorise(
      deps(
        (call) => {
          now += 10_000;
          return answer(() => [refOf(call, 'Food'), 0.9])(call);
        },
        { maxRowsPerRun: 5, batchSize: 2, maxRunMs: 25_000, now: () => now },
      ),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(3);
  });

  it('stops passing on a rate limit', async () => {
    for (let i = 0; i < 12; i += 1) await insertTx({ rawDescription: `R${i}` });
    const result = await aiCategorise(
      deps(
        (call, n) => {
          if (n === 1) throw Object.assign(new Error('limited'), { status: 429 });
          return answer(() => [refOf(call, 'Food'), 0.9])(call);
        },
        { maxRowsPerRun: 5, batchSize: 5 },
      ),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ status: 'rate_limited', applied: 5 });
  });

  describe('findHouseholdsWithAiWork', () => {
    it('lists households with AI on and at least one row the AI would judge', async () => {
      expect(await findHouseholdsWithAiWork(ctx.db)).not.toContain(ctx.householdId);
      await insertTx({ rawDescription: 'PENDING', status: 'pending' });
      await insertTx({ rawDescription: 'SPENT', aiAttempts: 3 });
      await insertTx({ rawDescription: 'DONE', categoryId: food });
      expect(await findHouseholdsWithAiWork(ctx.db)).not.toContain(ctx.householdId);
      await insertTx({ rawDescription: 'NEW' });
      expect(await findHouseholdsWithAiWork(ctx.db)).toContain(ctx.householdId);
      // AI off: never listed, whatever is waiting.
      await insertTx({ accountId: offAccountId }, off);
      expect(await findHouseholdsWithAiWork(ctx.db)).not.toContain(off.householdId);
    });
  });

  it('stops the run on a 429 or 5xx without touching the rest', async () => {
    for (let i = 0; i < 250; i += 1) await insertTx({ rawDescription: `R${i}` });
    for (const status of [429, 503]) {
      calls = [];
      const result = await aiCategorise(
        deps((call, n) => {
          if (n === 1) throw Object.assign(new Error('limited'), { status });
          return answer(() => [refOf(call, 'Food'), 0.9])(call);
        }),
        { householdId: ctx.householdId },
      );
      expect(calls).toHaveLength(2);
      expect(result).toMatchObject({ status: 'rate_limited', applied: expect.any(Number) });
      // Restore the rows for the next round.
      await t.owner
        .update(schema.transaction)
        .set({
          categoryId: null,
          categorisedBy: null,
          needsReview: true,
          aiConfidence: null,
          aiAttempts: 0,
        })
        .where(eq(schema.transaction.householdId, ctx.householdId));
    }
  });

  it('lets a concurrent user edit win', async () => {
    const raced = await insertTx({ rawDescription: 'RACED' });
    const free = await insertTx({ rawDescription: 'FREE' });
    const result = await aiCategorise(
      deps(async (call) => {
        // The user categorises one row while the model is thinking.
        await categoriseTransaction(ctx, { id: raced, categoryId: fun });
        return answer(() => [refOf(call, 'Food'), 0.95])(call);
      }),
      { householdId: ctx.householdId },
    );
    expect(result).toMatchObject({ applied: 1, skipped: 1 });
    expect(await stored(raced)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
    expect((await stored(free)).categoryId).toBe(food);
  });

  it('never applies to a row that became a transfer meanwhile', async () => {
    const row = await insertTx({ rawDescription: 'BECOMES TRANSFER' });
    await aiCategorise(
      deps(async (call) => {
        await t.owner
          .update(schema.transaction)
          .set({ transferGroupId: '22222222-2222-4222-8222-222222222222', categoryId: transferCat })
          .where(eq(schema.transaction.id, row));
        return answer(() => [refOf(call, 'Food'), 0.95])(call);
      }),
      { householdId: ctx.householdId },
    );
    expect((await stored(row)).categoryId).toBe(transferCat);
  });

  it('does nothing when the household has AI off', async () => {
    await insertTx({ accountId: offAccountId }, off);
    const result = await aiCategorise(
      { ...deps(() => ({ items: [] })), db: off.db },
      { householdId: off.householdId },
    );
    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      status: 'disabled',
      applied: 0,
      review: 0,
      fallback: 0,
      skipped: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('does nothing without an API key', async () => {
    await insertTx();
    const result = await aiCategorise(
      deps(() => ({ items: [] }), { anthropic: null }),
      {
        householdId: ctx.householdId,
      },
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: 'no_api_key', applied: 0, review: 0 });
  });

  it('makes no call when nothing is waiting', async () => {
    const result = await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ status: 'done', applied: 0, skipped: 0 });
  });

  it('applies a refund to an expense, but never an income category to spending', async () => {
    const spend = await insertTx({ rawDescription: 'SPEND', amount: -1_000 });
    const refund = await insertTx({ rawDescription: 'REFUND', amount: 1_000 });
    const pay = await insertTx({ rawDescription: 'PAY', amount: 200_000 });
    const result = await aiCategorise(
      deps((call) =>
        answer((r) =>
          r.description === 'PAY'
            ? [refOf(call, 'Salary'), 0.95]
            : r.description === 'SPEND'
              ? [refOf(call, 'Salary'), 0.95]
              : [refOf(call, 'Food'), 0.95],
        )(call),
      ),
      { householdId: ctx.householdId },
    );
    expect(result).toMatchObject({ applied: 2, review: 0, skipped: 1 });
    expect(await stored(refund)).toMatchObject({ categoryId: food, aiAttempts: 1 });
    expect(await stored(pay)).toMatchObject({ categorisedBy: 'ai', needsReview: false });
    // An expense paid with an income category is a failed attempt.
    expect(await stored(spend)).toMatchObject({
      categoryId: null,
      aiSuggestedCategoryId: null,
      needsReview: true,
      aiAttempts: 1,
    });
  });

  it('counts rows the model omitted or answered unusably as an attempt and sends them again', async () => {
    const omitted = await insertTx({ rawDescription: 'OMITTED' });
    const unknown = await insertTx({ rawDescription: 'UNKNOWN' });
    await aiCategorise(
      deps((call) => {
        const row = rowsOf(call).find((r) => r.description === 'UNKNOWN')!;
        return { items: [{ id: row.id, categoryId: 'c999', confidence: 0.99 }] };
      }),
      { householdId: ctx.householdId },
    );
    expect((await stored(omitted)).aiAttempts).toBe(1);
    expect((await stored(unknown)).aiAttempts).toBe(1);
    calls = [];
    await aiCategorise(
      deps(() => ({ items: [] })),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(1);
    expect(rowsOf(calls[0]!)).toHaveLength(2);
  });

  it('survives a category deleted while the model was answering', async () => {
    const gone = await insertTx({ rawDescription: 'GONE' });
    const kept = await insertTx({ rawDescription: 'KEPT' });
    const group = await createCategoryGroup(ctx, { name: 'Temp', kind: 'expense' });
    const temp = await createCategory(ctx, { groupId: group.id, name: 'Temp cat' });
    const warnings: string[] = [];
    const result = await aiCategorise(
      deps(
        async (call) => {
          const tempRef = refOf(call, 'Temp cat');
          await t.owner.delete(schema.category).where(eq(schema.category.id, temp.id));
          return answer((r) => [r.description === 'GONE' ? tempRef : refOf(call, 'Food'), 0.95])(
            call,
          );
        },
        { logger: { info: () => {}, warn: (m) => warnings.push(m) } },
      ),
      { householdId: ctx.householdId },
    );
    expect(await stored(gone)).toMatchObject({ categoryId: null, aiAttempts: 1 });
    expect((await stored(kept)).categoryId).toBe(food);
    expect(result.applied).toBe(1);
    expect(warnings.join(' ')).toContain('category');
  });

  describe('attempts', () => {
    const none = () => ({ items: [] });

    it('counts every row sent, whatever the model answers', async () => {
      const hi = await insertTx({ rawDescription: 'HI' });
      const miss = await insertTx({ rawDescription: 'MISS' });
      await aiCategorise(
        deps((call) =>
          answer((r) => [r.description === 'HI' ? refOf(call, 'Food') : null, 0.9])(call),
        ),
        { householdId: ctx.householdId },
      );
      expect((await stored(hi)).aiAttempts).toBe(1);
      expect((await stored(miss)).aiAttempts).toBe(1);
    });

    it('counts a batch that failed or came back unusable', async () => {
      const rows: string[] = [];
      for (let i = 0; i < 300; i += 1) rows.push(await insertTx({ rawDescription: `R${i}` }));
      const result = await aiCategorise(
        deps((call, n) => {
          if (n === 0) throw new Error('boom SECRET-DESCRIPTION');
          if (n === 1) return null;
          return answer(() => [refOf(call, 'Food'), 0.9])(call);
        }),
        { householdId: ctx.householdId },
      );
      expect(result).toMatchObject({ applied: 100, skipped: 200 });
      const attempts = await t.owner
        .select({ n: schema.transaction.aiAttempts, c: sql<number>`count(*)::int` })
        .from(schema.transaction)
        .where(eq(schema.transaction.householdId, ctx.householdId))
        .groupBy(schema.transaction.aiAttempts);
      expect(attempts).toEqual([{ n: 1, c: 300 }]);
    });

    it('does not count a rate limit or provider outage, nor rows that were never sent', async () => {
      for (let i = 0; i < 4; i += 1) await insertTx({ rawDescription: `R${i}` });
      await aiCategorise(
        deps(() => {
          throw Object.assign(new Error('limited'), { status: 429 });
        }),
        { householdId: ctx.householdId },
      );
      const counts = async () =>
        (await t.owner.select().from(schema.transaction)).map((r) => r.aiAttempts).sort();
      expect(await counts()).toEqual([0, 0, 0, 0]);
      await aiCategorise(deps(none, { maxRowsPerRun: 1, maxPassesPerRun: 1 }), {
        householdId: ctx.householdId,
      });
      expect(await counts()).toEqual([0, 0, 0, 1]);
    });

    it.each([
      [401, 'invalid x-api-key'],
      [403, 'forbidden'],
      [400, 'Your credit balance is too low to access the Anthropic API'],
      [400, 'Billing problem on this account'],
      [400, 'Quota exceeded'],
    ])('does not count a broken key or billing problem (%s %s)', async (status, message) => {
      const id = await insertTx({ aiAttempts: 2 });
      const result = await aiCategorise(
        deps(() => {
          throw Object.assign(new Error(message), { status });
        }),
        { householdId: ctx.householdId },
      );
      expect(result.status).toBe('rate_limited');
      expect(await stored(id)).toMatchObject({ aiAttempts: 2, categoryId: null });
    });

    it('counts a 400 about the content of the request', async () => {
      const id = await insertTx({});
      await aiCategorise(
        deps(() => {
          throw Object.assign(new Error('messages.0.content: invalid characters'), { status: 400 });
        }),
        { householdId: ctx.householdId },
      );
      expect((await stored(id)).aiAttempts).toBe(1);
    });

    it('does not re-judge a row the user took back from the AI, and never gives it Outros', async () => {
      const id = await insertTx({
        categoryId: food,
        categorisedBy: 'ai',
        aiConfidence: 0.9,
        confidence: 0.9,
        needsReview: false,
        aiAttempts: 1,
      });
      await undoAiCategorisation(ctx, id);
      await aiCategorise(deps(none), { householdId: ctx.householdId });
      expect(calls).toHaveLength(0);
      expect(await stored(id)).toMatchObject({
        categoryId: null,
        needsReview: true,
        aiAttempts: 3,
      });
    });

    it('does not count rows a rule or merchant memory categorised', async () => {
      await createRule(ctx, {
        name: 'groceries',
        condition: { descriptionContains: 'continente' },
        categoryId: food,
      });
      await ingestTransactions(
        ctx,
        accountId,
        [
          { bookingDate: '2026-10-05', amount: -500, currency: 'EUR', description: 'CONTINENTE 1' },
          { bookingDate: '2026-10-05', amount: -700, currency: 'EUR', description: 'UNKNOWN SHOP' },
        ],
        { source: 'connector' },
      );
      await aiCategorise(deps(none), { householdId: ctx.householdId });
      expect(calls.flatMap(rowsOf).map((r) => r.description)).toEqual(['UNKNOWN SHOP']);
      const rows = await t.owner
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.householdId, ctx.householdId));
      const ruled = rows.find((r) => r.rawDescription === 'CONTINENTE 1')!;
      expect(ruled).toMatchObject({ categoryId: food, aiAttempts: 0 });
    });
  });

  describe('giving up', () => {
    type Home = { ctx: ServiceCtx; accountId: string; daily: { id: string } | null };
    const home = async (opts: { locale?: string; seed?: boolean; ai?: boolean } = {}) => {
      const h = await t.household({ locale: opts.locale ?? 'en' });
      if (opts.ai !== false) {
        await withHousehold(h.db, h.householdId, (tx) =>
          tx
            .update(schema.householdSettings)
            .set({ aiEnabled: true })
            .where(eq(schema.householdSettings.householdId, h.householdId)),
        );
      }
      let daily: { id: string } | null = null;
      if (opts.seed !== false) {
        await seedCategoryTemplates(h, opts.locale === 'pt-PT' ? 'pt-PT' : 'en');
      } else {
        // The model needs at least one category to choose from.
        daily = await createCategoryGroup(h, { name: 'Daily', kind: 'expense' });
        await createCategory(h, { groupId: daily.id, name: 'Food' });
      }
      const account = await createAccount(h, { name: 'Main', type: 'checking' });
      return { ctx: h, accountId: account.id, daily };
    };
    /** Sends a row on its third attempt, and the model has nothing to offer. */
    const giveUp = async (h: Home, amount = -1_250) => {
      const id = await insertTx({ accountId: h.accountId, amount, aiAttempts: 2 }, h.ctx);
      const result = await aiCategorise(
        { ...deps(() => ({ items: [] })), db: h.ctx.db },
        { householdId: h.ctx.householdId },
      );
      const row = await stored(id);
      const [cat] = row.categoryId
        ? await t.owner.select().from(schema.category).where(eq(schema.category.id, row.categoryId))
        : [];
      return { row, cat, result };
    };
    const expectGivenUp = (row: Awaited<ReturnType<typeof giveUp>>['row']) =>
      expect(row).toMatchObject({
        categorisedBy: 'ai',
        confidence: 0,
        aiConfidence: 0,
        needsReview: true,
        aiAttempts: 3,
      });

    it('puts an outflow in the household "Outros" template category', async () => {
      const { row, cat, result } = await giveUp(await home({ locale: 'pt-PT' }));
      expect(result).toMatchObject({ fallback: 1, applied: 0, review: 0 });
      expectGivenUp(row);
      expect(cat).toMatchObject({ templateKey: 'leisure.other', name: 'Outros' });
    });

    it('puts an inflow in "Outras receitas"', async () => {
      const { row, cat } = await giveUp(await home({ locale: 'pt-PT' }), 50_000);
      expectGivenUp(row);
      expect(cat).toMatchObject({ templateKey: 'income.other', name: 'Outras receitas' });
    });

    it('also gives up when the third attempt is a failed batch', async () => {
      const id = await insertTx({ aiAttempts: 2 });
      await aiCategorise(
        deps(() => {
          throw new Error('boom');
        }),
        { householdId: ctx.householdId },
      );
      const row = await stored(id);
      expectGivenUp(row);
      expect(row.categoryId).toBe(other);
    });

    it('uses the income template category for an inflow in the shared household', async () => {
      const id = await insertTx({ aiAttempts: 2, amount: 5_000 });
      await aiCategorise(
        deps(() => ({ items: [] })),
        { householdId: ctx.householdId },
      );
      expect(await stored(id)).toMatchObject({ categoryId: otherIncome, needsReview: true });
    });

    it('gives up on a kind mismatch too', async () => {
      const id = await insertTx({ aiAttempts: 2, amount: -900 });
      await aiCategorise(
        deps((call) => answer(() => [refOf(call, 'Salary'), 0.99])(call)),
        { householdId: ctx.householdId },
      );
      expect(await stored(id)).toMatchObject({ categoryId: other, aiConfidence: 0 });
    });

    it('finds a custom expense category called Outros, ignoring case and accents', async () => {
      const h = await home({ seed: false });
      const mine = await createCategory(h.ctx, { groupId: h.daily!.id, name: 'ÓUTROS' });
      const { row } = await giveUp(h);
      expectGivenUp(row);
      expect(row.categoryId).toBe(mine.id);
    });

    it('does not take an income category named Other for an expense', async () => {
      const h = await home({ seed: false });
      const income = await createCategoryGroup(h.ctx, { name: 'Money in', kind: 'income' });
      const taken = await createCategory(h.ctx, { groupId: income.id, name: 'Other' });
      const { row, cat } = await giveUp(h);
      expect(row.categoryId).not.toBe(taken.id);
      expect(cat).toMatchObject({ templateKey: 'leisure.other', name: 'Other' });
    });

    it('creates "Other" in the leisure group when it is missing, once', async () => {
      const h = await home();
      await t.owner
        .delete(schema.category)
        .where(
          and(
            eq(schema.category.householdId, h.ctx.householdId),
            eq(schema.category.templateKey, 'leisure.other'),
          ),
        );
      const first = await giveUp(h);
      expect(first.cat).toMatchObject({ templateKey: 'leisure.other', name: 'Other' });
      const [leisure] = await t.owner
        .select()
        .from(schema.categoryGroup)
        .where(
          and(
            eq(schema.categoryGroup.householdId, h.ctx.householdId),
            eq(schema.categoryGroup.templateKey, 'leisure'),
          ),
        );
      expect(first.cat!.groupId).toBe(leisure!.id);
      const second = await giveUp(h);
      expect(second.cat!.id).toBe(first.cat!.id);
    });

    it('creates the leisure group from the template when the household has none', async () => {
      const h = await home({ seed: false, locale: 'pt-PT' });
      const { row, cat } = await giveUp(h);
      expectGivenUp(row);
      const [group] = await t.owner
        .select()
        .from(schema.categoryGroup)
        .where(eq(schema.categoryGroup.id, cat!.groupId));
      expect(group).toMatchObject({ templateKey: 'leisure', kind: 'expense' });
      expect(cat).toMatchObject({ templateKey: 'leisure.other', name: 'Outros' });
    });

    it('uses the first open expense group when the leisure group is archived', async () => {
      const h = await home({ seed: false });
      const daily = h.daily!;
      const [archived] = await t.owner
        .insert(schema.categoryGroup)
        .values({
          householdId: h.ctx.householdId,
          name: 'Leisure and other',
          kind: 'expense',
          templateKey: 'leisure',
          archivedAt: new Date(),
          sort: -1,
        })
        .returning();
      const { cat } = await giveUp(h);
      expect(cat!.groupId).toBe(daily.id);
      expect(cat!.groupId).not.toBe(archived!.id);
    });

    it('un-archives an archived Other rather than creating a second one', async () => {
      const h = await home();
      const all = (await listCategories(h.ctx, { includeArchived: true })).flatMap(
        (g) => g.categories,
      );
      const archivedOther = all.find((c) => c.templateKey === 'leisure.other')!;
      await t.owner
        .update(schema.category)
        .set({ archivedAt: new Date() })
        .where(eq(schema.category.id, archivedOther.id));
      const { cat } = await giveUp(h);
      expect(cat).toMatchObject({ id: archivedOther.id, archivedAt: null });
      const incomeOther = all.find((c) => c.templateKey === 'income.other')!;
      await t.owner
        .update(schema.category)
        .set({ archivedAt: new Date() })
        .where(eq(schema.category.id, incomeOther.id));
      const inflow = await giveUp(h, 4_000);
      expect(inflow.cat).toMatchObject({ id: incomeOther.id, archivedAt: null });
    });

    it('creates "Other income" for an inflow when the household has none', async () => {
      const h = await home({ seed: false });
      const { row, cat } = await giveUp(h, 10_000);
      expectGivenUp(row);
      expect(cat).toMatchObject({ templateKey: 'income.other', name: 'Other income' });
    });

    it('does nothing when the household has AI off, however many attempts a row has', async () => {
      const h = await home({ ai: false });
      const id = await insertTx({ accountId: h.accountId, aiAttempts: 2 }, h.ctx);
      const result = await aiCategorise(
        { ...deps(() => ({ items: [] })), db: h.ctx.db },
        { householdId: h.ctx.householdId },
      );
      expect(result.status).toBe('disabled');
      expect(calls).toHaveLength(0);
      expect(await stored(id)).toMatchObject({ categoryId: null, aiAttempts: 2 });
    });

    it('never touches user-edited, user-categorised or transfer rows', async () => {
      const edited = await insertTx({ userEditedAt: new Date(), aiAttempts: 2 });
      const mine = await insertTx({
        categoryId: fun,
        categorisedBy: 'user',
        userEditedAt: new Date(),
        needsReview: false,
        aiAttempts: 2,
      });
      const transfer = await insertTx({
        transferGroupId: '33333333-3333-4333-8333-333333333333',
        aiAttempts: 2,
      });
      await aiCategorise(
        deps(() => ({ items: [] })),
        { householdId: ctx.householdId },
      );
      expect(calls).toHaveLength(0);
      expect(await stored(edited)).toMatchObject({ categoryId: null, aiAttempts: 2 });
      expect(await stored(mine)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
      expect(await stored(transfer)).toMatchObject({ categoryId: null, aiAttempts: 2 });
    });
  });

  describe('migration backfill', () => {
    const file = readdirSync(new URL('../../../db/migrations/', import.meta.url)).find((f) =>
      f.startsWith('0040_'),
    )!;
    const backfill = readFileSync(
      new URL(`../../../db/migrations/${file}`, import.meta.url),
      'utf8',
    )
      .split('-- BACKFILL\n')[1]!
      .split('--> statement-breakpoint')
      .map((q) => q.trim())
      .filter(Boolean);

    it('applies stored suggestions, re-opens rows judged once and leaves people alone', async () => {
      const suggested = await insertTx({ aiSuggestedCategoryId: food, aiConfidence: 0.7 });
      const misfit = await insertTx({
        amount: -1_000,
        aiSuggestedCategoryId: (await listCategories(ctx))
          .flatMap((g) => g.categories)
          .find((c) => c.name === 'Salary')!.id,
        aiConfidence: 0.7,
      });
      const judged = await insertTx({ aiConfidence: 0.2 });
      const fresh = await insertTx({});
      const edited = await insertTx({
        aiSuggestedCategoryId: food,
        aiConfidence: 0.7,
        userEditedAt: new Date(),
      });
      const transfer = await insertTx({
        aiSuggestedCategoryId: food,
        aiConfidence: 0.7,
        transferGroupId: '44444444-4444-4444-8444-444444444444',
      });
      const categorised = await insertTx({
        categoryId: fun,
        categorisedBy: 'ai',
        aiConfidence: 0.9,
        needsReview: false,
      });

      for (const statement of backfill) await t.owner.execute(sql.raw(statement));

      expect(await stored(suggested)).toMatchObject({
        categoryId: food,
        categorisedBy: 'ai',
        confidence: expect.closeTo(0.7),
        needsReview: true,
        aiAttempts: 1,
      });
      expect(await stored(misfit)).toMatchObject({
        categoryId: null,
        aiSuggestedCategoryId: null,
        aiConfidence: null,
        aiAttempts: 1,
      });
      expect(await stored(judged)).toMatchObject({
        categoryId: null,
        aiConfidence: null,
        aiAttempts: 1,
      });
      expect(await stored(fresh)).toMatchObject({ categoryId: null, aiAttempts: 0 });
      expect(await stored(edited)).toMatchObject({
        categoryId: null,
        aiConfidence: expect.closeTo(0.7),
        aiAttempts: 0,
      });
      expect(await stored(transfer)).toMatchObject({ categoryId: null, aiAttempts: 0 });
      expect(await stored(categorised)).toMatchObject({ categoryId: fun, aiAttempts: 0 });
    });
  });
});
