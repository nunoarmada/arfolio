import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  applyRule,
  createCategory,
  createCategoryGroup,
  createRule,
  ForbiddenError,
  NotFoundError,
  previewRuleApplication,
  revertRuleApplication,
  updateRule,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { auditLog, transaction, undoToken } = schema;

type Row = {
  desc: string;
  amount?: number;
  categoryId?: string | null;
  by?: 'rule' | 'memory' | 'ai' | 'user' | null;
  needsReview?: boolean;
  confidence?: number | null;
  transfer?: boolean;
  status?: 'pending' | 'booked';
};

describe('apply a rule to existing transactions', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let accountId: string;
  let food: string;
  let fun: string;

  beforeAll(async () => {
    t = await startServicesDb();
    await t.owner.insert(schema.user).values({ id: 'user-1', name: 'u', email: 'u@example.test' });
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    a = await t.household();
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    food = (await createCategory(a, { groupId: group.id, name: 'Food' })).id;
    fun = (await createCategory(a, { groupId: group.id, name: 'Fun' })).id;
    accountId = await withHousehold(a.db, a.householdId, async (tx) => {
      const [acc] = await tx
        .insert(schema.financialAccount)
        .values({ householdId: a.householdId, name: 'Main', type: 'checking' })
        .returning();
      return acc!.id;
    });
  });

  async function addRows(ctx: ServiceCtx, acc: string, rows: Row[]): Promise<string[]> {
    return withHousehold(ctx.db, ctx.householdId, async (tx) => {
      const out = await tx
        .insert(transaction)
        .values(
          rows.map((r) => ({
            householdId: ctx.householdId,
            accountId: acc,
            dedupeHash: randomUUID(),
            bookingDate: '2026-01-10',
            amount: r.amount ?? -1_000,
            currency: 'EUR',
            status: r.status ?? ('booked' as const),
            rawDescription: r.desc,
            source: 'manual' as const,
            categoryId: r.categoryId ?? null,
            categorisedBy: r.by ?? null,
            needsReview: r.needsReview ?? false,
            confidence: r.confidence ?? null,
            transferGroupId: r.transfer ? randomUUID() : null,
          })),
        )
        .returning({ id: transaction.id });
      return out.map((o) => o.id);
    });
  }

  const load = (ctx: ServiceCtx, id: string) =>
    withHousehold(ctx.db, ctx.householdId, async (tx) => {
      const [r] = await tx.select().from(transaction).where(eq(transaction.id, id));
      return r!;
    });

  const shopRule = (ctx: ServiceCtx = a, categoryId = food, priority?: number) =>
    createRule(ctx, {
      name: 'Shop',
      condition: { descriptionContains: 'shop' },
      categoryId,
      ...(priority !== undefined ? { priority } : {}),
    });

  describe('previewRuleApplication', () => {
    it('counts matching eligible rows and those that would change', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [
        { desc: 'SHOP one' }, // uncategorised: changes
        { desc: 'shop two', categoryId: fun, by: 'memory' }, // other category: changes
        { desc: 'shop three', categoryId: food, by: 'ai' }, // right category, wrong provenance: changes
        { desc: 'shop four', categoryId: food, by: 'rule' }, // already correct
        { desc: 'shop pending', status: 'pending' }, // any status: changes
        { desc: 'bakery' }, // no match
      ]);
      expect(await previewRuleApplication(a, r.id)).toEqual({ matches: 5, changes: 4 });
    });

    it('leaves out rows a higher-priority rule claims', async () => {
      const low = await shopRule(a, food, 20);
      await createRule(a, {
        name: 'Big shop',
        condition: { descriptionContains: 'big' },
        categoryId: fun,
        priority: 10,
      });
      await addRows(a, accountId, [{ desc: 'big shop' }, { desc: 'small shop' }]);
      expect(await previewRuleApplication(a, low.id)).toEqual({ matches: 1, changes: 1 });
    });

    it('skips user-categorised rows and transfer legs', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [
        { desc: 'shop user', categoryId: fun, by: 'user' },
        { desc: 'shop transfer', transfer: true },
        { desc: 'shop ok' },
      ]);
      expect(await previewRuleApplication(a, r.id)).toEqual({ matches: 1, changes: 1 });
    });

    it('returns zeros for a disabled rule', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop' }]);
      await updateRule(a, r.id, { enabled: false });
      expect(await previewRuleApplication(a, r.id)).toEqual({ matches: 0, changes: 0 });
    });

    it('is allowed for viewers and refuses unknown ids', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop' }]);
      expect(await previewRuleApplication(withRole(a, 'viewer'), r.id)).toEqual({
        matches: 1,
        changes: 1,
      });
      await expect(previewRuleApplication(a, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      await expect(previewRuleApplication(a, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects a rule whose category is archived', async () => {
      const r = await shopRule();
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.category)
          .set({ archivedAt: new Date() })
          .where(eq(schema.category.id, food)),
      );
      await expect(previewRuleApplication(a, r.id)).rejects.toBeInstanceOf(ValidationError);
      await expect(applyRule(a, r.id)).rejects.toBeInstanceOf(ValidationError);
    });

    it("never sees another household's rows or rules", async () => {
      const b = await t.household();
      const group = await createCategoryGroup(b, { name: 'G', kind: 'expense' });
      const bCat = (await createCategory(b, { groupId: group.id, name: 'Food' })).id;
      const bAcc = await withHousehold(b.db, b.householdId, async (tx) => {
        const [acc] = await tx
          .insert(schema.financialAccount)
          .values({ householdId: b.householdId, name: 'Main', type: 'checking' })
          .returning();
        return acc!.id;
      });
      const ruleA = await shopRule();
      const bRows = await addRows(b, bAcc, [{ desc: 'shop b' }]);
      await addRows(a, accountId, [{ desc: 'shop a' }]);
      expect(await previewRuleApplication(a, ruleA.id)).toEqual({ matches: 1, changes: 1 });
      await expect(previewRuleApplication(b, ruleA.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(applyRule(b, ruleA.id)).rejects.toBeInstanceOf(NotFoundError);
      const ruleB = await shopRule(b, bCat);
      await applyRule(a, ruleA.id);
      expect((await load(b, bRows[0]!)).categoryId).toBeNull();
      expect(await previewRuleApplication(b, ruleB.id)).toEqual({ matches: 1, changes: 1 });
    });
  });

  describe('applyRule', () => {
    it('changes exactly the previewed rows and records the new state', async () => {
      const r = await shopRule();
      const [fresh, other, correct, user, transfer, nomatch] = await addRows(a, accountId, [
        { desc: 'shop one', needsReview: true },
        { desc: 'shop two', categoryId: fun, by: 'memory', confidence: 0.9 },
        { desc: 'shop three', categoryId: food, by: 'rule', confidence: 1 },
        { desc: 'shop user', categoryId: fun, by: 'user' },
        { desc: 'shop transfer', transfer: true },
        { desc: 'bakery' },
      ]);
      const preview = await previewRuleApplication(a, r.id);
      const res = await applyRule(a, r.id);
      expect(res.changed).toBe(preview.changes);
      expect(res.changed).toBe(2);
      expect(res.undoToken).toEqual(expect.any(String));
      expect(await load(a, fresh!)).toMatchObject({
        categoryId: food,
        categorisedBy: 'rule',
        confidence: 1,
        needsReview: false,
      });
      expect(await load(a, other!)).toMatchObject({ categoryId: food, categorisedBy: 'rule' });
      expect(await load(a, correct!)).toMatchObject({ categoryId: food, categorisedBy: 'rule' });
      expect(await load(a, user!)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
      expect((await load(a, transfer!)).categoryId).toBeNull();
      expect((await load(a, nomatch!)).categoryId).toBeNull();
      expect(await previewRuleApplication(a, r.id)).toEqual({ matches: 3, changes: 0 });
    });

    it('leaves a row alone that the user categorises between the lookup and the update', async () => {
      const r = await shopRule();
      const [mine, theirs] = await addRows(a, accountId, [
        { desc: 'shop mine' },
        { desc: 'shop theirs' },
      ]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => (locked = resolve));
      // Another connection edits `theirs` by hand and keeps the row locked (uncommitted).
      const edit = t.owner.transaction(async (tx) => {
        await tx
          .update(transaction)
          .set({ categoryId: fun, categorisedBy: 'user' })
          .where(eq(transaction.id, theirs!));
        locked();
        await held;
      });
      await ready;
      const applying = applyRule(a, r.id);
      // The apply has read both rows as uncategorised and is now waiting on the locked row.
      for (let i = 0; i < 100; i += 1) {
        const waiting = await t.owner.execute(
          sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and state = 'active'`,
        );
        if (waiting.rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await edit;
      const res = await applying;
      expect(res.changed).toBe(1);
      expect(await load(a, theirs!)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
      expect(await load(a, mine!)).toMatchObject({ categoryId: food, categorisedBy: 'rule' });
      const [stored] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(undoToken),
      );
      const rows = (stored!.payload as { rows: Array<{ id: string }> }).rows;
      expect(rows.map((x) => x.id)).toEqual([mine]);
    });

    it('returns no token and writes no undo row when nothing changes', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop', categoryId: food, by: 'rule' }]);
      expect(await applyRule(a, r.id)).toEqual({ changed: 0, undoToken: null });
      const tokens = await withHousehold(a.db, a.householdId, (tx) => tx.select().from(undoToken));
      expect(tokens).toHaveLength(0);
    });

    it('changes nothing for a disabled rule', async () => {
      const r = await shopRule();
      const [id] = await addRows(a, accountId, [{ desc: 'shop' }]);
      await updateRule(a, r.id, { enabled: false });
      expect(await applyRule(a, r.id)).toEqual({ changed: 0, undoToken: null });
      expect((await load(a, id!)).categoryId).toBeNull();
    });

    it('refuses viewers', async () => {
      const r = await shopRule();
      await expect(applyRule(withRole(a, 'viewer'), r.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('writes the audit row and the token in the same transaction', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop' }]);
      const res = await applyRule(a, r.id);
      const audits = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.action, 'rule.apply')),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor: 'web',
        targetType: 'rule',
        targetId: r.id,
        userId: a.userId,
      });
      const [tok] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(undoToken).where(eq(undoToken.id, res.undoToken!)),
      );
      expect(tok).toMatchObject({ kind: 'rule_application', userId: a.userId });
    });

    it('handles more rows than one update chunk', async () => {
      const r = await shopRule();
      const rows: Row[] = Array.from({ length: 2_300 }, (_, i) => ({ desc: `shop ${i}` }));
      await addRows(a, accountId, rows);
      expect(await applyRule(a, r.id)).toMatchObject({ changed: 2_300 });
    });
  });

  describe('revertRuleApplication', () => {
    it('restores the previous state of every changed row', async () => {
      const r = await shopRule();
      const [fresh, other] = await addRows(a, accountId, [
        { desc: 'shop one', needsReview: true },
        { desc: 'shop two', categoryId: fun, by: 'ai', confidence: 0.7 },
      ]);
      const { undoToken: token } = await applyRule(a, r.id);
      expect(await revertRuleApplication(a, token!)).toEqual({ restored: 2, kept: 0 });
      expect(await load(a, fresh!)).toMatchObject({
        categoryId: null,
        categorisedBy: null,
        confidence: null,
        needsReview: true,
      });
      expect(await load(a, other!)).toMatchObject({
        categoryId: fun,
        categorisedBy: 'ai',
        confidence: 0.7,
        needsReview: false,
      });
    });

    it('leaves rows alone that changed after the apply', async () => {
      const r = await shopRule();
      const [kept, edited, recategorised] = await addRows(a, accountId, [
        { desc: 'shop one' },
        { desc: 'shop two' },
        { desc: 'shop three' },
      ]);
      const { undoToken: token } = await applyRule(a, r.id);
      await withHousehold(a.db, a.householdId, async (tx) => {
        await tx
          .update(transaction)
          .set({ categoryId: fun, categorisedBy: 'user' })
          .where(eq(transaction.id, edited!));
        await tx
          .update(transaction)
          .set({ categoryId: fun })
          .where(eq(transaction.id, recategorised!));
      });
      expect(await revertRuleApplication(a, token!)).toEqual({ restored: 1, kept: 2 });
      expect((await load(a, kept!)).categoryId).toBeNull();
      expect(await load(a, edited!)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
      expect((await load(a, recategorised!)).categoryId).toBe(fun);
    });

    it('works once only', async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop' }]);
      const { undoToken: token } = await applyRule(a, r.id);
      await revertRuleApplication(a, token!);
      await expect(revertRuleApplication(a, token!)).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses an expired token', async () => {
      const r = await shopRule();
      const [id] = await addRows(a, accountId, [{ desc: 'shop' }]);
      const { undoToken: token } = await applyRule(a, r.id);
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(undoToken)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(undoToken.id, token!)),
      );
      await expect(revertRuleApplication(a, token!)).rejects.toBeInstanceOf(NotFoundError);
      expect((await load(a, id!)).categoryId).toBe(food);
    });

    it("refuses another user's token, another household and other kinds", async () => {
      const r = await shopRule();
      await addRows(a, accountId, [{ desc: 'shop' }]);
      const { undoToken: token } = await applyRule(a, r.id);
      await expect(
        revertRuleApplication({ ...a, userId: 'user-2' }, token!),
      ).rejects.toBeInstanceOf(NotFoundError);
      const b = await t.household();
      await expect(revertRuleApplication(b, token!)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revertRuleApplication(withRole(a, 'viewer'), token!)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(revertRuleApplication(a, 'nope')).rejects.toBeInstanceOf(NotFoundError);
      // The token survives the refusals.
      expect(await revertRuleApplication(a, token!)).toEqual({ restored: 1, kept: 0 });
    });
  });
});
