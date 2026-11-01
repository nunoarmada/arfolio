import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  categoriseTransaction,
  ConflictError,
  countAiAppliedSince,
  createAccount,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  ForbiddenError,
  getTransaction,
  listReviewInbox,
  listTransactions,
  NotFoundError,
  undoAiCategorisation,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { transaction } = schema;
const DAY = 86_400_000;

describe('AI review queries', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let account: string;
  let food: string;
  let fun: string;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    const group = await createCategoryGroup(a, { name: 'Mine', kind: 'expense' });
    food = (await createCategory(a, { groupId: group.id, name: 'Food' })).id;
    fun = (await createCategory(a, { groupId: group.id, name: 'Fun' })).id;
    account = (await createAccount(a, { name: 'One', type: 'checking' })).id;
  });
  afterAll(() => t.close());

  let seq = 0;
  /** A row the AI applied with high confidence (out of review, category set). */
  async function aiApplied(over: Partial<typeof transaction.$inferInsert> = {}) {
    seq += 1;
    const row = await createManualTransaction(a, {
      accountId: account,
      bookingDate: '2026-06-10',
      amount: -1_000,
      description: `AI row ${seq}`,
    });
    await t.owner
      .update(transaction)
      .set({
        categoryId: food,
        categorisedBy: 'ai',
        confidence: 0.92,
        aiConfidence: 0.92,
        needsReview: false,
        userEditedAt: null,
        ...over,
      })
      .where(eq(transaction.id, row.id));
    return row.id;
  }

  /** Moves updated_at back without the trigger resetting it. */
  async function backdate(id: string, daysAgo: number) {
    await t.owner.execute(
      sql`alter table "transaction" disable trigger transaction_set_updated_at`,
    );
    try {
      await t.owner
        .update(transaction)
        .set({ updatedAt: new Date(Date.now() - daysAgo * DAY) })
        .where(eq(transaction.id, id));
    } finally {
      await t.owner.execute(
        sql`alter table "transaction" enable trigger transaction_set_updated_at`,
      );
    }
  }

  describe('undoAiCategorisation', () => {
    it('returns the row to review with the old category as its suggestion and keeps the confidence', async () => {
      const id = await aiApplied();
      const row = await undoAiCategorisation(a, id);
      expect(row).toMatchObject({
        id,
        categoryId: null,
        categorisedBy: null,
        confidence: null,
        needsReview: true,
        aiSuggestedCategoryId: food,
        aiConfidence: 0.92,
        userEditedAt: null,
      });
      expect(await getTransaction(a, id)).toMatchObject({ aiSuggestedCategoryId: food });
      const inbox = await listReviewInbox(a, { limit: 200 });
      expect(inbox.items.find((r) => r.id === id)).toMatchObject({ aiSuggestedCategoryId: food });
    });

    it('can be re-applied through the normal categorise path', async () => {
      const id = await aiApplied();
      const undone = await undoAiCategorisation(a, id);
      const result = await categoriseTransaction(a, {
        id,
        categoryId: undone.aiSuggestedCategoryId!,
      });
      expect(result.transaction).toMatchObject({ categoryId: food, categorisedBy: 'user' });
    });

    it('refuses rows that are not AI-applied or that a user edited, leaving them untouched', async () => {
      const edited = await aiApplied({ userEditedAt: new Date() });
      await expect(undoAiCategorisation(a, edited)).rejects.toBeInstanceOf(ConflictError);
      expect(await getTransaction(a, edited)).toMatchObject({ categoryId: food });

      const byUser = await aiApplied({ categorisedBy: 'user' });
      await expect(undoAiCategorisation(a, byUser)).rejects.toMatchObject({
        code: 'ai_categorisation_changed',
      });

      // Once undone, a second undo is a conflict too (nothing to undo).
      const once = await aiApplied();
      await undoAiCategorisation(a, once);
      await expect(undoAiCategorisation(a, once)).rejects.toBeInstanceOf(ConflictError);
    });

    it('is writer-only and household scoped', async () => {
      const id = await aiApplied();
      await expect(undoAiCategorisation(withRole(a, 'viewer'), id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(undoAiCategorisation(b, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(undoAiCategorisation(a, 'nope')).rejects.toBeInstanceOf(NotFoundError);
      expect(await getTransaction(a, id)).toMatchObject({ categoryId: food, categorisedBy: 'ai' });
    });
  });

  describe('listing AI rows', () => {
    it('filters by categorisedBy ai and counts AI-applied rows in the window', async () => {
      const fresh = await aiApplied();
      const old = await aiApplied();
      await backdate(old, 45);
      const user = await createManualTransaction(a, {
        accountId: account,
        bookingDate: '2026-06-10',
        amount: -500,
        description: 'By hand',
        categoryId: fun,
      });
      const before = await countAiAppliedSince(a);
      const ids = (await listTransactions(a, { categorisedBy: 'ai', limit: 200 })).items.map(
        (r) => r.id,
      );
      expect(ids).toContain(fresh);
      expect(ids).toContain(old);
      expect(ids).not.toContain(user.id);

      expect(await countAiAppliedSince(a, 30)).toBe(before);
      expect(await countAiAppliedSince(a, 60)).toBe(before + 1);
      expect(await countAiAppliedSince(b, 3_650)).toBe(0);
      // Undone rows no longer count.
      await undoAiCategorisation(a, fresh);
      expect(await countAiAppliedSince(a, 30)).toBe(before - 1);
      await expect(listTransactions(a, { categorisedBy: 'nope' as never })).rejects.toThrow();
    });

    it('lets viewers read both', async () => {
      const viewer = withRole(a, 'viewer');
      await expect(countAiAppliedSince(viewer)).resolves.toBeGreaterThanOrEqual(0);
      await expect(listTransactions(viewer, { categorisedBy: 'ai' })).resolves.toBeDefined();
    });
  });
});
