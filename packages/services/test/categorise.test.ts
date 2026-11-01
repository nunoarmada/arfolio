import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  categoriseTransaction,
  archiveCategory,
  createAccount,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  dismissTransferHint,
  findTransferCandidates,
  findTransferCandidatesFor,
  ForbiddenError,
  getTransaction,
  listCategories,
  listRules,
  listTransactions,
  markTransfer,
  reorderCategories,
  reorderCategoryGroups,
  reorderRules,
  createRule,
  revertCategorisation,
  seedCategoryTemplates,
  summariseMonth,
  updateTransaction,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('categorise, revert, transfers, summary, ordering', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let acc1: string;
  let acc2: string;
  let food: string;
  let fun: string;

  const merchants = () =>
    withHousehold(a.db, a.householdId, (tx) => tx.select().from(schema.merchant));
  const row = (id: string) => getTransaction(a, id);
  const ruleOf = async (token: string) => {
    const [stored] = await t.owner
      .select()
      .from(schema.undoToken)
      .where(eq(schema.undoToken.id, token));
    return (stored!.payload as { ruleId: string | null }).ruleId;
  };
  const manual = (description: string, over: Record<string, unknown> = {}) =>
    createManualTransaction(a, {
      accountId: acc1,
      bookingDate: '2026-06-10',
      amount: -1_000,
      description,
      ...over,
    });

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household({ locale: 'en' });
    b = await t.household();
    await seedCategoryTemplates(a, 'en');
    const group = await createCategoryGroup(a, { name: 'Mine', kind: 'expense' });
    food = (await createCategory(a, { groupId: group.id, name: 'Food' })).id;
    fun = (await createCategory(a, { groupId: group.id, name: 'Fun' })).id;
    acc1 = (await createAccount(a, { name: 'One', type: 'checking' })).id;
    acc2 = (await createAccount(a, { name: 'Two', type: 'savings' })).id;
  });
  afterAll(() => t.close());

  describe('applyToMerchant', () => {
    it('also categorises the other uncategorised rows of the merchant, never user or transfer rows', async () => {
      const target = await manual('Zeta Cafe 01/06');
      const sameOpen = await manual('ZETA CAFE 02/06');
      const sameElsewhere = await manual('Zeta Cafe', { accountId: acc2 });
      const byUser = await manual('Zeta Cafe 03/06', { categoryId: fun });
      const other = await manual('Different Shop');
      const leg = await manual('Zeta Cafe refund', { amount: 1_000, accountId: acc2 });
      const out = await manual('Zeta Cafe move', { amount: -1_000 });
      await markTransfer(a, out.id, leg.id);

      const result = await categoriseTransaction(a, { id: target.id, categoryId: food });
      expect(result.alsoApplied).toBe(2);
      expect(await row(target.id)).toMatchObject({ categoryId: food, categorisedBy: 'user' });
      for (const id of [sameOpen.id, sameElsewhere.id]) {
        expect(await row(id)).toMatchObject({
          categoryId: food,
          categorisedBy: 'memory',
          needsReview: false,
        });
      }
      expect(await row(byUser.id)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
      expect(await row(other.id)).toMatchObject({ categoryId: null, needsReview: true });
      expect((await row(out.id)).transferGroupId).not.toBeNull();
      const m = (await merchants()).find((x) => x.key === 'ZETA CAFE')!;
      expect(m.defaultCategoryId).toBe(food);
    });

    it('leaves other rows alone with applyToMerchant false', async () => {
      const target = await manual('Solo Vendor 01/06');
      const same = await manual('Solo Vendor 02/06');
      const r = await categoriseTransaction(a, {
        id: target.id,
        categoryId: food,
        applyToMerchant: false,
      });
      expect(r.alsoApplied).toBe(0);
      expect(await row(same.id)).toMatchObject({ categoryId: null });
    });

    it('updateTransaction behaves the same for a category choice', async () => {
      const target = await manual('Upd Vendor 01/06');
      const same = await manual('Upd Vendor 02/06');
      await updateTransaction(a, target.id, { categoryId: food });
      expect(await row(same.id)).toMatchObject({ categoryId: food, categorisedBy: 'memory' });
    });
  });

  describe('merchant matching', () => {
    it('matches spacing and date variants of the same merchant, not other merchants', async () => {
      const target = await manual('CONTINENTE LISBOA');
      const spaced = await manual('CONTINENTE   LISBOA');
      const dated = await manual('CONTINENTE 12/03 LISBOA');
      const other = await manual('CONTINENTE PORTO');
      const r = await categoriseTransaction(a, { id: target.id, categoryId: food });
      expect(r.alsoApplied).toBe(2);
      for (const id of [spaced.id, dated.id]) expect((await row(id)).categoryId).toBe(food);
      expect((await row(other.id)).categoryId).toBeNull();
    });
  });

  describe('revertCategorisation', () => {
    it('restores the row, the other rows, a created merchant and the rule', async () => {
      const target = await manual('Rev Store 01/06');
      const same = await manual('Rev Store 02/06');
      const before = await row(target.id);
      const r = await categoriseTransaction(a, {
        id: target.id,
        categoryId: food,
        createRule: true,
      });
      const ruleId = await ruleOf(r.undoToken);
      expect(ruleId).not.toBeNull();
      expect((await listRules(a)).some((x) => x.id === ruleId)).toBe(true);

      await revertCategorisation(a, r.undoToken);
      const after = await row(target.id);
      expect(after).toMatchObject({
        categoryId: null,
        categorisedBy: null,
        needsReview: true,
        merchantId: null,
        userEditedAt: before.userEditedAt,
      });
      expect(await row(same.id)).toMatchObject({
        categoryId: null,
        needsReview: true,
        merchantId: null,
      });
      expect((await listRules(a)).some((x) => x.id === ruleId)).toBe(false);
      expect((await merchants()).some((m) => m.key === 'REV STORE')).toBe(false);
    });

    it('restores an existing merchant default and the previous provenance', async () => {
      const first = await manual('Memo Shop 01/06');
      await categoriseTransaction(a, { id: first.id, categoryId: food });
      const second = await manual('Memo Shop 02/06', { categoryId: undefined });
      // second was already memory-categorised by the first call; recategorise it to Fun.
      const prev = await row(second.id);
      expect(prev.categorisedBy).toBe('memory');
      const r = await categoriseTransaction(a, { id: second.id, categoryId: fun });
      expect((await merchants()).find((m) => m.key === 'MEMO SHOP')!.defaultCategoryId).toBe(fun);
      await revertCategorisation(a, r.undoToken);
      expect(await row(second.id)).toMatchObject({ categoryId: food, categorisedBy: 'memory' });
      expect((await merchants()).find((m) => m.key === 'MEMO SHOP')!.defaultCategoryId).toBe(food);
    });

    it('does not undo what the user decided on other rows in the meantime', async () => {
      const target = await manual('Late Edit 01/06');
      const same = await manual('Late Edit 02/06');
      const r = await categoriseTransaction(a, { id: target.id, categoryId: food });
      await updateTransaction(a, same.id, { categoryId: fun, applyToMerchant: false });
      await revertCategorisation(a, r.undoToken);
      expect(await row(same.id)).toMatchObject({ categoryId: fun, categorisedBy: 'user' });
    });

    it('refuses to revert a change that unlinked a transfer, and malformed tokens', async () => {
      const out = await manual('Leg out', { amount: -2_000 });
      const inn = await manual('Leg in', { amount: 2_000, accountId: acc2 });
      await markTransfer(a, out.id, inn.id);
      const r = await categoriseTransaction(a, { id: out.id, categoryId: food });
      await expect(revertCategorisation(a, r.undoToken)).rejects.toBeInstanceOf(ValidationError);
      await expect(revertCategorisation(a, 'not-a-token')).rejects.toThrow(/not found/i);
    });

    it('is household-scoped and refused for viewers', async () => {
      const target = await manual('Scope Shop');
      const r = await categoriseTransaction(a, { id: target.id, categoryId: food });
      await expect(
        categoriseTransaction(withRole(a, 'viewer'), { id: target.id, categoryId: food }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(revertCategorisation(withRole(a, 'viewer'), r.undoToken)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(revertCategorisation(b, r.undoToken)).rejects.toThrow(/not found/i);
    });
  });

  describe('undo tokens', () => {
    it("are the caller's own, single-use, unexpired and household-bound", async () => {
      const target = await manual('Token Shop 01/06');
      const r = await categoriseTransaction(a, { id: target.id, categoryId: food });
      expect(r).not.toHaveProperty('snapshot');
      const other = { ...a, userId: 'user-2' };
      await expect(revertCategorisation(other, r.undoToken)).rejects.toThrow(/not found/i);
      await expect(revertCategorisation(b, r.undoToken)).rejects.toThrow(/not found/i);
      await revertCategorisation(a, r.undoToken);
      await expect(revertCategorisation(a, r.undoToken)).rejects.toThrow(/already used/i);

      const again = await categoriseTransaction(a, { id: target.id, categoryId: food });
      await t.owner
        .update(schema.undoToken)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.undoToken.id, again.undoToken));
      await expect(revertCategorisation(a, again.undoToken)).rejects.toThrow(/not found/i);
      const left = await t.owner
        .select()
        .from(schema.undoToken)
        .where(eq(schema.undoToken.id, again.undoToken));
      expect(left).toEqual([]);
    });

    it('refuse to restore a category that is no longer usable', async () => {
      const group = await createCategoryGroup(a, { name: 'Soon gone', kind: 'expense' });
      const doomed = (await createCategory(a, { groupId: group.id, name: 'Doomed' })).id;
      const target = await manual('Doom Shop 01/06', { categoryId: doomed });
      const r = await categoriseTransaction(a, { id: target.id, categoryId: food });
      await archiveCategory(a, doomed);
      await expect(revertCategorisation(a, r.undoToken)).rejects.toBeInstanceOf(ValidationError);
      expect((await row(target.id)).categoryId).toBe(food);
    });
  });

  describe('transfers', () => {
    it('getTransaction returns the other leg; findTransferCandidates lists matches nearest first', async () => {
      const out = await manual('Cand out', { amount: -7_700, bookingDate: '2026-07-10' });
      const near = await manual('Cand near', {
        amount: 7_700,
        accountId: acc2,
        bookingDate: '2026-07-11',
      });
      const far = await manual('Cand far', {
        amount: 7_700,
        accountId: acc2,
        bookingDate: '2026-07-14',
      });
      await manual('Cand wrong amount', {
        amount: 7_701,
        accountId: acc2,
        bookingDate: '2026-07-10',
      });
      await manual('Cand same account', { amount: 7_700, bookingDate: '2026-07-10' });
      await manual('Cand too far', { amount: 7_700, accountId: acc2, bookingDate: '2026-07-30' });

      const found = await findTransferCandidates(a, out.id);
      expect(found.map((r) => r.id)).toEqual([near.id, far.id]);
      expect(await findTransferCandidates(a, out.id, { windowDays: 1 })).toHaveLength(1);

      expect((await getTransaction(a, out.id)).transferPartner).toBeNull();
      await markTransfer(a, out.id, near.id);
      const linked = await getTransaction(a, out.id);
      expect(linked.transferPartner).toMatchObject({
        id: near.id,
        accountId: acc2,
        accountName: 'Two',
        amount: 7_700,
      });
      expect(await findTransferCandidates(a, out.id)).toEqual([]);
      await expect(findTransferCandidates(b, out.id)).rejects.toThrow(/not found/i);
    });
  });

  describe('transfer candidates, locks and hints', () => {
    it('offers a locked leg to a person (includeLocked) but not to automatic pairing, and markTransfer accepts it', async () => {
      const out = await manual('Lock out', { amount: -4_400, bookingDate: '2026-09-10' });
      const inn = await manual('Lock in', {
        amount: 4_400,
        accountId: acc2,
        bookingDate: '2026-09-10',
      });
      await dismissTransferHint(a, out.id, inn.id);
      expect(await findTransferCandidates(a, out.id)).toEqual([]);
      const manualOffer = await findTransferCandidates(a, out.id, { includeLocked: true });
      expect(manualOffer.map((r) => r.id)).toEqual([inn.id]);
      await markTransfer(a, out.id, inn.id);
      expect((await getTransaction(a, out.id)).transferPartner?.id).toBe(inn.id);
    });

    it('findTransferCandidatesFor answers many rows in one call, per id', async () => {
      const o1 = await manual('Set out 1', { amount: -5_501, bookingDate: '2026-10-01' });
      const o2 = await manual('Set out 2', { amount: -5_502, bookingDate: '2026-10-01' });
      const i1 = await manual('Set in 1', {
        amount: 5_501,
        accountId: acc2,
        bookingDate: '2026-10-02',
      });
      const none = await manual('Set none', { amount: -5_503, bookingDate: '2026-10-01' });
      const map = await findTransferCandidatesFor(a, [o1.id, o2.id, none.id, i1.id]);
      expect(map.get(o1.id)!.map((r) => r.id)).toEqual([i1.id]);
      expect(map.get(i1.id)!.map((r) => r.id)).toEqual([o1.id]);
      expect(map.get(o2.id)).toEqual([]);
      expect(map.get(none.id)).toEqual([]);
      expect(await findTransferCandidatesFor(b, [o1.id])).toEqual(new Map([[o1.id, []]]));
      expect((await findTransferCandidatesFor(a, [])).size).toBe(0);
    });

    it('dismissTransferHint locks both unlinked rows, is household-scoped and refused for viewers', async () => {
      const x = await manual('Dismiss x', { amount: -6_600, bookingDate: '2026-10-05' });
      const y = await manual('Dismiss y', {
        amount: 6_600,
        accountId: acc2,
        bookingDate: '2026-10-05',
      });
      await expect(dismissTransferHint(withRole(a, 'viewer'), x.id, y.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(dismissTransferHint(b, x.id, y.id)).rejects.toThrow(/not found/i);
      await dismissTransferHint(a, x.id, y.id);
      expect((await row(x.id)).transferLocked).toBe(true);
      expect((await row(y.id)).transferLocked).toBe(true);
    });

    it('undo is refused once the row became a transfer leg, and the pair stays consistent', async () => {
      const x = await manual('Revert transfer out', { amount: -8_800, bookingDate: '2026-10-08' });
      const y = await manual('Revert transfer in', {
        amount: 8_800,
        accountId: acc2,
        bookingDate: '2026-10-08',
      });
      const r = await categoriseTransaction(a, { id: x.id, categoryId: food });
      await markTransfer(a, x.id, y.id);
      await expect(revertCategorisation(a, r.undoToken)).rejects.toThrow(/changed since/i);
      const after = await getTransaction(a, x.id);
      expect(after.transferGroupId).not.toBeNull();
      expect(after.transferPartner?.id).toBe(y.id);
      // The token was spent by the refusal.
      await expect(revertCategorisation(a, r.undoToken)).rejects.toThrow(/already used/i);
    });
  });

  describe('summariseMonth and list filters', () => {
    it('aggregates per currency, excluding pending, transfers and other months', async () => {
      const ctx = await t.household({ locale: 'en' });
      await seedCategoryTemplates(ctx, 'en');
      const eur = (await createAccount(ctx, { name: 'E', type: 'checking' })).id;
      const usd = (await createAccount(ctx, { name: 'U', type: 'checking', currency: 'USD' })).id;
      const add = (accountId: string, bookingDate: string, amount: number, d: string) =>
        createManualTransaction(ctx, { accountId, bookingDate, amount, description: d });
      await add(eur, '2026-08-02', -4_520, 'a');
      await add(eur, '2026-08-03', -1_000, 'b');
      await add(eur, '2026-08-04', 185_000, 'c');
      await add(eur, '2026-09-01', -999, 'next month');
      await add(usd, '2026-08-05', -300, 'dollar');
      await add(eur, '2026-08-06', -25_000, 'to savings');
      await add(usd, '2026-08-06', 25_000, 'from checking');
      const legIn = await add(eur, '2026-08-06', 25_000, 'leg in');
      const legOut = await createManualTransaction(ctx, {
        accountId: usd,
        bookingDate: '2026-08-06',
        amount: -25_000,
        description: 'leg out',
      });
      await markTransfer(ctx, legIn.id, legOut.id);

      const summary = await summariseMonth(ctx, { from: '2026-08-01', to: '2026-08-31' });
      const byCurrency = Object.fromEntries(summary.map((s) => [s.currency, s]));
      expect(byCurrency.EUR).toMatchObject({ income: 185_000, expense: 25_000 + 4_520 + 1_000 });
      expect(byCurrency.USD).toMatchObject({ income: 25_000, expense: 300 });
      expect(byCurrency.EUR!.uncategorised).toBeGreaterThan(0);
      await expect(summariseMonth(ctx, { from: 'x', to: '2026-08-31' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await summariseMonth(b, { from: '2026-08-01', to: '2026-08-31' })).toEqual([]);
    });

    it('filters by direction and status', async () => {
      const out = await listTransactions(a, { direction: 'out', limit: 200 });
      expect(out.items.length).toBeGreaterThan(0);
      expect(out.items.every((r) => r.amount < 0)).toBe(true);
      const inn = await listTransactions(a, { direction: 'in', limit: 200 });
      expect(inn.items.every((r) => r.amount > 0)).toBe(true);
      const pending = await listTransactions(a, { status: 'pending' });
      expect(pending.items).toEqual([]);
      const booked = await listTransactions(a, { status: 'booked', limit: 5 });
      expect(booked.items.every((r) => r.status === 'booked')).toBe(true);
    });
  });

  describe('reordering', () => {
    it('reorders groups, categories and rules in one call and validates the lists', async () => {
      const groups = (await listCategories(a)).filter((g) => !g.templateKey);
      const mine = groups[0]!;
      const ids = mine.categories.map((c) => c.id).reverse();
      await reorderCategories(a, ids);
      const after = (await listCategories(a)).find((g) => g.id === mine.id)!;
      expect(after.categories.map((c) => c.id).slice(0, ids.length)).toEqual(ids);

      const g2 = await createCategoryGroup(a, { name: 'Another', kind: 'expense' });
      const groupsNow = await listCategories(a);
      const transferGroup = groupsNow.find((g) => g.kind === 'transfer')!;
      const orderable = groupsNow.filter((g) => g.kind !== 'transfer').map((g) => g.id);
      const reordered = [g2.id, ...orderable.filter((id) => id !== g2.id)];
      // The UI never sends the transfer group; it stays last.
      await reorderCategoryGroups(a, reordered);
      expect((await listCategories(a)).map((g) => g.id)).toEqual([...reordered, transferGroup.id]);
      await expect(reorderCategoryGroups(a, [g2.id, g2.id])).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(reorderCategoryGroups(a, [g2.id])).rejects.toBeInstanceOf(ValidationError);
      await expect(reorderCategoryGroups(b, [g2.id])).rejects.toBeInstanceOf(ValidationError);
      await expect(reorderCategories(a, ids.slice(1))).rejects.toBeInstanceOf(ValidationError);
      await expect(reorderCategories(a, [])).rejects.toBeInstanceOf(ValidationError);

      const r1 = await createRule(a, {
        name: 'r1',
        condition: { descriptionContains: 'x1' },
        categoryId: food,
      });
      const r2 = await createRule(a, {
        name: 'r2',
        condition: { descriptionContains: 'x2' },
        categoryId: food,
      });
      const all = (await listRules(a)).map((r) => r.id);
      const flipped = [...all].reverse();
      await reorderRules(a, flipped);
      expect((await listRules(a)).map((r) => r.id)).toEqual(flipped);
      expect(flipped).toContain(r1.id);
      expect(flipped).toContain(r2.id);
      await expect(reorderRules(a, [r1.id])).rejects.toBeInstanceOf(ValidationError);
      await expect(reorderRules(withRole(a, 'viewer'), flipped)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it('keeps unrelated tables untouched by revert (sanity: merchant count stable)', async () => {
    const before = (await merchants()).length;
    const x = await manual('Sanity Shop');
    const r = await categoriseTransaction(a, { id: x.id, categoryId: food });
    await revertCategorisation(a, r.undoToken);
    expect((await merchants()).length).toBe(before);
  });
});
