import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveAccount,
  archiveCategory,
  categoriseTransaction,
  createAccount,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  createRule,
  deleteManualTransaction,
  ForbiddenError,
  getTransaction,
  ingestTransactions,
  listCategories,
  listTransactions,
  markTransfer,
  NotFoundError,
  seedCategoryTemplates,
  unlinkTransfer,
  updateTransaction,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { lockTransfers } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('transactions service', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let acc1: string;
  let acc2: string;
  let food: string;
  let fun: string;
  let transferCat: string;

  const merchants = (ctx: ServiceCtx) =>
    withHousehold(ctx.db, ctx.householdId, (tx) => tx.select().from(schema.merchant));
  const manual = (over: Record<string, unknown> = {}) =>
    createManualTransaction(a, {
      accountId: acc1,
      bookingDate: '2026-04-10',
      amount: -1_000,
      description: 'Lunch spot',
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
    transferCat = (await listCategories(a))
      .flatMap((g) => g.categories)
      .find((c) => c.templateKey === 'transfer.between_accounts')!.id;
    acc1 = (await createAccount(a, { name: 'One', type: 'checking' })).id;
    acc2 = (await createAccount(a, { name: 'Two', type: 'savings' })).id;
  });
  afterAll(() => t.close());

  describe('createManualTransaction', () => {
    it('creates a booked manual row in the account currency, flagged for review when unmatched', async () => {
      const row = await manual({ counterparty: 'Spot Ltd', notes: 'n' });
      expect(row).toMatchObject({
        source: 'manual',
        status: 'booked',
        currency: 'EUR',
        amount: -1_000,
        rawDescription: 'Lunch spot',
        counterparty: 'Spot Ltd',
        notes: 'n',
        categoryId: null,
        needsReview: true,
      });
      expect(row.dedupeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores the user category directly, without review', async () => {
      const row = await manual({ categoryId: food, description: 'Picked' });
      expect(row).toMatchObject({ categoryId: food, categorisedBy: 'user', needsReview: false });
    });

    it('applies rules to rows created without a category', async () => {
      await createRule(a, {
        name: 'fun',
        condition: { descriptionContains: 'cinema' },
        categoryId: fun,
      });
      const row = await manual({ description: 'CINEMA Night' });
      expect(row).toMatchObject({ categoryId: fun, categorisedBy: 'rule', needsReview: false });
    });

    it('allows identical manual rows (they never dedupe)', async () => {
      const x = await manual({ description: 'twin' });
      const y = await manual({ description: 'twin' });
      expect(x.id).not.toBe(y.id);
    });

    it('rejects bad input, unknown accounts and archived categories', async () => {
      await expect(manual({ amount: 1.5 })).rejects.toBeInstanceOf(ValidationError);
      await expect(manual({ bookingDate: '10/04/2026' })).rejects.toBeInstanceOf(ValidationError);
      await expect(manual({ description: '  ' })).rejects.toBeInstanceOf(ValidationError);
      await expect(manual({ accountId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(manual({ categoryId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
      const group = await createCategoryGroup(a, { name: 'Old', kind: 'expense' });
      const old = await createCategory(a, { groupId: group.id, name: 'Old' });
      await archiveCategory(a, old.id);
      await expect(manual({ categoryId: old.id })).rejects.toBeInstanceOf(ValidationError);
      const archived = await createAccount(a, { name: 'Gone', type: 'cash' });
      await archiveAccount(a, archived.id);
      await expect(manual({ accountId: archived.id })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('updateTransaction', () => {
    it('sets category, marks it user-categorised, clears review and learns the merchant', async () => {
      const row = await manual({ description: 'COMPRA Bistro Azul 12/04' });
      const updated = await updateTransaction(a, row.id, { categoryId: food });
      expect(updated).toMatchObject({
        categoryId: food,
        categorisedBy: 'user',
        needsReview: false,
      });
      expect(updated.userEditedAt).toBeInstanceOf(Date);
      expect(updated.merchantId).not.toBeNull();
      const m = (await merchants(a)).find((x) => x.id === updated.merchantId)!;
      expect(m).toMatchObject({ key: 'BISTRO AZUL', defaultCategoryId: food });
    });

    it('re-pointing the same merchant updates the memory instead of duplicating it', async () => {
      const r1 = await manual({ description: 'Kiosk Verde' });
      const r2 = await manual({ description: 'KIOSK  VERDE 99/01' });
      await updateTransaction(a, r1.id, { categoryId: food });
      await updateTransaction(a, r2.id, { categoryId: fun });
      const rows = (await merchants(a)).filter((m) => m.key === 'KIOSK VERDE');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.defaultCategoryId).toBe(fun);
    });

    it('keeps merchant memory untouched when applyToMerchant is false', async () => {
      const before = (await merchants(a)).length;
      const row = await manual({ description: 'One Off Vendor' });
      const updated = await updateTransaction(a, row.id, {
        categoryId: food,
        applyToMerchant: false,
      });
      expect(updated).toMatchObject({ categoryId: food, categorisedBy: 'user', merchantId: null });
      expect((await merchants(a)).length).toBe(before);
    });

    it('notes alone do not change the category or review state', async () => {
      const row = await manual({ description: 'Needs note' });
      const updated = await updateTransaction(a, row.id, { notes: 'remember' });
      expect(updated).toMatchObject({
        notes: 'remember',
        categoryId: null,
        categorisedBy: null,
        needsReview: true,
      });
      expect(updated.userEditedAt).toBeInstanceOf(Date);
      expect((await updateTransaction(a, row.id, { notes: null })).notes).toBeNull();
    });

    it('clears the category with null: back to review, still the same row, memory kept by default', async () => {
      const row = await manual({ description: 'Clear Shop 1' });
      const set = await updateTransaction(a, row.id, { categoryId: food });
      const cleared = await updateTransaction(a, row.id, { categoryId: null });
      expect(cleared).toMatchObject({
        categoryId: null,
        categorisedBy: null,
        confidence: null,
        needsReview: true,
        merchantId: set.merchantId,
      });
      const m = (await merchants(a)).find((x) => x.id === set.merchantId)!;
      expect(m.defaultCategoryId).toBe(food);
    });

    it('clearing the category keeps the row away from the AI sweep and its fallback', async () => {
      const row = await manual({ description: 'Clear Shop 3' });
      await updateTransaction(a, row.id, { categoryId: food });
      await updateTransaction(a, row.id, { categoryId: null });
      const [stored] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(schema.transaction).where(eq(schema.transaction.id, row.id)),
      );
      expect(stored!.aiAttempts).toBeGreaterThanOrEqual(3);
      expect(stored!.userEditedAt).toBeInstanceOf(Date);
    });

    it('applying a category to a merchant also re-categorises its AI-categorised rows, never rule or user rows', async () => {
      const source = await manual({ description: 'Zeta Bakery' });
      const aiRow = await manual({ description: 'Zeta Bakery' });
      const ruleRow = await manual({ description: 'Zeta Bakery' });
      const userRow = await manual({ description: 'Zeta Bakery' });
      await updateTransaction(a, userRow.id, { categoryId: fun, applyToMerchant: false });
      const setBy = (id: string, by: 'ai' | 'rule') =>
        withHousehold(a.db, a.householdId, (tx) =>
          tx
            .update(schema.transaction)
            .set({ categoryId: fun, categorisedBy: by, needsReview: false })
            .where(eq(schema.transaction.id, id)),
        );
      await setBy(aiRow.id, 'ai');
      await setBy(ruleRow.id, 'rule');
      await updateTransaction(a, source.id, { categoryId: food });
      expect(await getTransaction(a, aiRow.id)).toMatchObject({
        categoryId: food,
        categorisedBy: 'memory',
      });
      expect(await getTransaction(a, ruleRow.id)).toMatchObject({ categoryId: fun });
      expect(await getTransaction(a, userRow.id)).toMatchObject({ categoryId: fun });
    });

    it('clears the merchant memory too when applyToMerchant is true', async () => {
      const row = await manual({ description: 'Clear Shop 2' });
      const set = await updateTransaction(a, row.id, { categoryId: food });
      await updateTransaction(a, row.id, { categoryId: null, applyToMerchant: true });
      const m = (await merchants(a)).find((x) => x.id === set.merchantId)!;
      expect(m.defaultCategoryId).toBeNull();
    });

    it('clearing a transfer leg unlinks the pair and returns both legs to review', async () => {
      const out = await manual({ amount: -7_000, description: 'to savings clear' });
      const inn = await manual({
        accountId: acc2,
        amount: 7_000,
        description: 'from checking clear',
      });
      await markTransfer(a, out.id, inn.id);
      await updateTransaction(a, out.id, { categoryId: null });
      for (const id of [out.id, inn.id]) {
        expect(await getTransaction(a, id)).toMatchObject({
          transferGroupId: null,
          categoryId: null,
          needsReview: true,
        });
      }
    });

    it('rejects unknown and archived categories and bad input', async () => {
      const row = await manual({ description: 'Validate me' });
      await expect(
        updateTransaction(a, row.id, { categoryId: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateTransaction(a, row.id, { categoryId: food, bogus: 1 } as never),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses the transfer category on a row that is not part of a transfer', async () => {
      const row = await manual({ description: 'not a transfer' });
      await expect(
        updateTransaction(a, row.id, { categoryId: transferCat }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses the transfer category via categoriseTransaction and manual creation too', async () => {
      const row = await manual({ description: 'not a transfer either' });
      await expect(
        categoriseTransaction(a, { id: row.id, categoryId: transferCat }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(manual({ categoryId: transferCat })).rejects.toBeInstanceOf(ValidationError);
    });

    it('recategorising a transfer leg unlinks the pair and returns the other leg to review', async () => {
      const out = await manual({ amount: -5_000, description: 'to savings' });
      const inn = await manual({ accountId: acc2, amount: 5_000, description: 'from checking' });
      await markTransfer(a, out.id, inn.id);
      await updateTransaction(a, out.id, { categoryId: food });
      const [o, i] = [await getTransaction(a, out.id), await getTransaction(a, inn.id)];
      expect(o).toMatchObject({ transferGroupId: null, categoryId: food });
      expect(i).toMatchObject({ transferGroupId: null, categoryId: null, needsReview: true });
    });
  });

  describe('listTransactions', () => {
    let ctx: ServiceCtx;
    let account: string;
    beforeAll(async () => {
      ctx = await t.household();
      await seedCategoryTemplates(ctx, 'en');
      account = (await createAccount(ctx, { name: 'L', type: 'checking' })).id;
      const other = (await createAccount(ctx, { name: 'L2', type: 'checking' })).id;
      const group = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
      const c = await createCategory(ctx, { groupId: group.id, name: 'C' });
      const mk = (accountId: string, bookingDate: string, description: string, extra = {}) =>
        createManualTransaction(ctx, {
          accountId,
          bookingDate,
          amount: -100,
          description,
          ...extra,
        });
      await mk(account, '2026-05-01', 'alpha store');
      await mk(account, '2026-05-02', '100% cotton', { categoryId: c.id });
      await mk(account, '2026-05-03', 'under_score');
      await mk(account, '2026-05-03', 'beta', { notes: 'Findme note', counterparty: 'Corner Co' });
      await mk(other, '2026-05-04', 'other account');
    });

    it('orders by booking date desc then id and paginates with a cursor', async () => {
      const all = await listTransactions(ctx, { limit: 200 });
      expect(all.nextCursor).toBeNull();
      expect(all.items.map((i) => i.bookingDate)).toEqual([
        '2026-05-04',
        '2026-05-03',
        '2026-05-03',
        '2026-05-02',
        '2026-05-01',
      ]);
      const sameDay = all.items.filter((i) => i.bookingDate === '2026-05-03').map((i) => i.id);
      expect(sameDay).toEqual([...sameDay].sort());

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listTransactions(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(all.items.map((i) => i.id));
    });

    it('filters by account, category, date range, review flag and search', async () => {
      expect((await listTransactions(ctx, { accountIds: [account] })).items).toHaveLength(4);
      const cat = (await listTransactions(ctx, { limit: 200 })).items.find((i) => i.categoryId)!;
      expect(
        (await listTransactions(ctx, { categoryIds: [cat.categoryId!] })).items.map((i) => i.id),
      ).toEqual([cat.id]);
      expect(
        (await listTransactions(ctx, { from: '2026-05-02', to: '2026-05-03' })).items,
      ).toHaveLength(3);
      expect((await listTransactions(ctx, { needsReview: false })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { needsReview: true })).items).toHaveLength(4);
      expect((await listTransactions(ctx, { search: 'ALPHA' })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { search: 'findme' })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { search: 'corner' })).items).toHaveLength(1);
    });

    it('orders, pages and filters by the purchase date when the bank books later (card statements)', async () => {
      const c = await t.household();
      const card = (await createAccount(c, { name: 'Card', type: 'card' })).id;
      await ingestTransactions(
        c,
        card,
        [
          {
            externalId: 'early',
            bookingDate: '2026-10-31',
            transactionDate: '2026-10-05',
            amount: -100,
            currency: 'EUR',
            description: 'early purchase',
          },
          {
            externalId: 'late',
            bookingDate: '2026-10-31',
            transactionDate: '2026-10-20',
            amount: -200,
            currency: 'EUR',
            description: 'late purchase',
          },
          {
            externalId: 'mid',
            bookingDate: '2026-10-12',
            amount: -300,
            currency: 'EUR',
            description: 'no purchase date',
          },
        ],
        { source: 'connector' },
      );
      const all = await listTransactions(c, { limit: 200 });
      expect(all.items.map((i) => [i.rawDescription, i.purchaseDate])).toEqual([
        ['late purchase', '2026-10-20'],
        ['no purchase date', '2026-10-12'],
        ['early purchase', '2026-10-05'],
      ]);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listTransactions(c, { limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(all.items.map((i) => i.id));

      const range = await listTransactions(c, { from: '2026-10-01', to: '2026-10-15' });
      expect(range.items.map((i) => i.rawDescription)).toEqual([
        'no purchase date',
        'early purchase',
      ]);
    });

    it('uncategorised: booked and pending rows without a category, never transfers', async () => {
      const c = await t.household();
      const acc = (await createAccount(c, { name: 'U1', type: 'checking' })).id;
      const acc2 = (await createAccount(c, { name: 'U2', type: 'savings' })).id;
      const group = await createCategoryGroup(c, { name: 'G', kind: 'expense' });
      const cat = (await createCategory(c, { groupId: group.id, name: 'Cat' })).id;
      const mk = (over: Record<string, unknown> = {}) =>
        createManualTransaction(c, {
          accountId: acc,
          bookingDate: '2026-06-01',
          amount: -500,
          description: 'row',
          ...over,
        });
      const plain = await mk();
      const categorised = await mk({ categoryId: cat });
      const out = await mk({ accountId: acc, amount: -7_000, description: 'move out' });
      const inn = await mk({ accountId: acc2, amount: 7_000, description: 'move in' });
      await markTransfer(c, out.id, inn.id);
      const [pending] = await withHousehold(c.db, c.householdId, (tx) =>
        tx
          .insert(schema.transaction)
          .values({
            householdId: c.householdId,
            accountId: acc,
            dedupeHash: 'pending-uncat',
            bookingDate: '2026-06-02',
            amount: -900,
            currency: 'EUR',
            status: 'pending',
            rawDescription: 'pending row',
            source: 'manual',
          })
          .returning({ id: schema.transaction.id }),
      );
      const ids = async (opts: Parameters<typeof listTransactions>[1] = {}) =>
        (await listTransactions(c, { uncategorised: true, ...opts })).items.map((i) => i.id).sort();
      expect(await ids()).toEqual([plain.id, pending!.id].sort());
      expect(await ids({ status: 'booked' })).toEqual([plain.id]);
      expect(await ids({ status: 'pending' })).toEqual([pending!.id]);
      expect(await ids({ direction: 'in' })).toEqual([]);
      expect(categorised.categoryId).toBe(cat);
      // Without the flag the categorised and transfer rows are listed too.
      expect((await listTransactions(c, { limit: 200 })).items).toHaveLength(5);
      expect((await listTransactions(c, { uncategorised: false, limit: 200 })).items).toHaveLength(
        5,
      );
    });

    it('uncategorised excludes a row that still carries a transfer group', async () => {
      const c = await t.household();
      const acc = (await createAccount(c, { name: 'U1', type: 'checking' })).id;
      const [row] = await withHousehold(c.db, c.householdId, (tx) =>
        tx
          .insert(schema.transaction)
          .values({
            householdId: c.householdId,
            accountId: acc,
            dedupeHash: 'grouped-uncat',
            bookingDate: '2026-06-02',
            amount: -900,
            currency: 'EUR',
            status: 'booked',
            rawDescription: 'grouped',
            source: 'manual',
            transferGroupId: crypto.randomUUID(),
          })
          .returning({ id: schema.transaction.id }),
      );
      expect(row).toBeDefined();
      expect((await listTransactions(c, { uncategorised: true })).items).toEqual([]);
    });

    it('excludeTransfers drops both legs of a transfer and keeps everything else', async () => {
      const c = await t.household({ locale: 'en' });
      await seedCategoryTemplates(c, 'en');
      const acc = (await createAccount(c, { name: 'X1', type: 'checking' })).id;
      const acc2 = (await createAccount(c, { name: 'X2', type: 'savings' })).id;
      const mk = (over: Record<string, unknown> = {}) =>
        createManualTransaction(c, {
          accountId: acc,
          bookingDate: '2026-06-01',
          amount: -500,
          description: 'row',
          ...over,
        });
      const plain = await mk();
      const out = await mk({ amount: -7_000, description: 'move out' });
      const inn = await mk({ accountId: acc2, amount: 7_000, description: 'move in' });
      await markTransfer(c, out.id, inn.id);
      const ids = async (opts: Parameters<typeof listTransactions>[1] = {}) =>
        (await listTransactions(c, { limit: 200, ...opts })).items.map((i) => i.id).sort();
      expect(await ids()).toEqual([plain.id, out.id, inn.id].sort());
      expect(await ids({ excludeTransfers: true })).toEqual([plain.id]);
      expect(await ids({ excludeTransfers: false })).toEqual([plain.id, out.id, inn.id].sort());
      // It combines with the other filters.
      expect(await ids({ excludeTransfers: true, direction: 'in' })).toEqual([]);
    });

    it('transfersOnly keeps both legs of a transfer and the transfer category, nothing else', async () => {
      const c = await t.household({ locale: 'en' });
      await seedCategoryTemplates(c, 'en');
      const acc = (await createAccount(c, { name: 'T1', type: 'checking' })).id;
      const acc2 = (await createAccount(c, { name: 'T2', type: 'savings' })).id;
      const transferCategory = (await listCategories(c))
        .flatMap((g) => g.categories)
        .find((cat) => cat.templateKey === 'transfer.between_accounts')!.id;
      const mk = (over: Record<string, unknown> = {}) =>
        createManualTransaction(c, {
          accountId: acc,
          bookingDate: '2026-06-01',
          amount: -500,
          description: 'row',
          ...over,
        });
      const plain = await mk();
      const out = await mk({ amount: -7_000, description: 'move out' });
      const inn = await mk({ accountId: acc2, amount: 7_000, description: 'move in' });
      await markTransfer(c, out.id, inn.id);
      const [tagged] = await withHousehold(c.db, c.householdId, (tx) =>
        tx
          .insert(schema.transaction)
          .values({
            householdId: c.householdId,
            accountId: acc,
            dedupeHash: 'transfers-only-category',
            bookingDate: '2026-06-02',
            amount: -900,
            currency: 'EUR',
            status: 'booked',
            rawDescription: 'category only',
            source: 'manual',
            categoryId: transferCategory,
          })
          .returning({ id: schema.transaction.id }),
      );
      const ids = async (opts: Parameters<typeof listTransactions>[1] = {}) =>
        (await listTransactions(c, { limit: 200, ...opts })).items.map((i) => i.id).sort();
      expect(await ids({ transfersOnly: true })).toEqual([out.id, inn.id, tagged!.id].sort());
      expect(await ids({ transfersOnly: false })).toEqual(
        [plain.id, out.id, inn.id, tagged!.id].sort(),
      );
      expect(await ids({ transfersOnly: true, accountIds: [acc2] })).toEqual([inn.id]);
    });

    it('excludeTransfers also drops a row that only carries the transfer category', async () => {
      const c = await t.household({ locale: 'en' });
      await seedCategoryTemplates(c, 'en');
      const acc = (await createAccount(c, { name: 'Y1', type: 'checking' })).id;
      const transferCategory = (await listCategories(c))
        .flatMap((g) => g.categories)
        .find((cat) => cat.templateKey === 'transfer.between_accounts')!.id;
      const plain = await createManualTransaction(c, {
        accountId: acc,
        bookingDate: '2026-06-01',
        amount: -500,
        description: 'plain',
      });
      // No transfer group, only the category: still a transfer.
      const [orphan] = await withHousehold(c.db, c.householdId, (tx) =>
        tx
          .insert(schema.transaction)
          .values({
            householdId: c.householdId,
            accountId: acc,
            dedupeHash: 'category-only-transfer',
            bookingDate: '2026-06-02',
            amount: -900,
            currency: 'EUR',
            status: 'booked',
            rawDescription: 'category only',
            source: 'manual',
            categoryId: transferCategory,
          })
          .returning({ id: schema.transaction.id }),
      );
      const ids = async (opts: Parameters<typeof listTransactions>[1] = {}) =>
        (await listTransactions(c, { limit: 200, ...opts })).items.map((i) => i.id).sort();
      expect(await ids()).toEqual([plain.id, orphan!.id].sort());
      expect(await ids({ excludeTransfers: true })).toEqual([plain.id]);
    });

    it('treats % and _ in the search text literally', async () => {
      expect((await listTransactions(ctx, { search: '100%' })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { search: '%' })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { search: 'r_s' })).items).toHaveLength(1);
      expect((await listTransactions(ctx, { search: 'a_p' })).items).toHaveLength(0);
    });

    it('clamps limits above 200 and rejects invalid limits and cursors', async () => {
      await expect(listTransactions(ctx, { limit: 1000 })).resolves.toBeTruthy();
      await expect(listTransactions(ctx, { limit: 0 })).rejects.toBeInstanceOf(ValidationError);
      await expect(listTransactions(ctx, { cursor: 'garbage' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(listTransactions(ctx, { accountIds: ['x'] })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('does not leak across households', async () => {
      expect((await listTransactions(b, {})).items).toEqual([]);
    });
  });

  describe('deleteManualTransaction', () => {
    it('deletes manual rows only, unlinking a transfer partner', async () => {
      const row = await manual({ description: 'delete me' });
      await deleteManualTransaction(a, row.id);
      await expect(getTransaction(a, row.id)).rejects.toBeInstanceOf(NotFoundError);

      const out = await manual({ amount: -700, description: 'x out' });
      const inn = await manual({ accountId: acc2, amount: 700, description: 'x in' });
      await markTransfer(a, out.id, inn.id);
      await deleteManualTransaction(a, out.id);
      expect(await getTransaction(a, inn.id)).toMatchObject({
        transferGroupId: null,
        needsReview: true,
      });

      await ingestTransactions(
        a,
        acc1,
        [{ bookingDate: '2026-04-01', amount: -1, currency: 'EUR', description: 'imported row' }],
        { source: 'import' },
      );
      const imported = (await listTransactions(a, { search: 'imported row' })).items[0]!;
      await expect(deleteManualTransaction(a, imported.id)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('transfer pairing and lock order', () => {
    /** Holds the household transfers lock until `release()`, like a concurrent pairing would. */
    async function holdTransfersLock() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => (locked = resolve));
      const holder = withHousehold(a.db, a.householdId, async (tx) => {
        await lockTransfers(tx, a.householdId);
        locked();
        await gate;
      });
      await ready;
      return { release, done: holder };
    }
    const stillPending = async (p: Promise<unknown>) => {
      const marker = Symbol('pending');
      const winner = await Promise.race([
        p.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise((resolve) => setTimeout(() => resolve(marker), 300)),
      ]);
      return winner === marker;
    };

    it('a notes-only edit does not exclude a row from automatic transfer pairing', async () => {
      const out = await manual({ amount: -7_770_001, description: 'notes pair out' });
      await updateTransaction(a, out.id, { notes: 'moving savings' });
      const [inn] = (
        await ingestTransactions(
          a,
          acc2,
          [
            {
              bookingDate: '2026-04-11',
              amount: 7_770_001,
              currency: 'EUR',
              description: 'notes pair in',
            },
          ],
          { source: 'import' },
        )
      ).insertedIds;
      const [o, i] = [await getTransaction(a, out.id), await getTransaction(a, inn!)];
      expect(o.transferGroupId).toBeTruthy();
      expect(o.transferGroupId).toBe(i.transferGroupId);
      expect(o.notes).toBe('moving savings');
    });

    it('marking and unlinking a transfer lock its legs against automatic re-pairing', async () => {
      const out = await manual({ amount: -7_770_002, description: 'lock out' });
      const inn = await manual({ accountId: acc2, amount: 7_770_002, description: 'lock in' });
      const group = await markTransfer(a, out.id, inn.id);
      expect(await getTransaction(a, out.id)).toMatchObject({ transferLocked: true });
      await unlinkTransfer(a, group);
      for (const id of [out.id, inn.id]) {
        expect(await getTransaction(a, id)).toMatchObject({ transferLocked: true });
      }
    });

    it('updateTransaction takes the transfers lock first, even for notes', async () => {
      const row = await manual({ description: 'lock order update' });
      const held = await holdTransfersLock();
      const edit = updateTransaction(a, row.id, { notes: 'x' });
      const blocked = await stillPending(edit).finally(held.release);
      await held.done;
      await edit;
      expect(blocked).toBe(true);
    });

    it('deleteManualTransaction takes the transfers lock first', async () => {
      const row = await manual({ description: 'lock order delete' });
      const held = await holdTransfersLock();
      const del = deleteManualTransaction(a, row.id);
      const blocked = await stillPending(del).finally(held.release);
      await held.done;
      await del;
      expect(blocked).toBe(true);
    });

    it('ingestTransactions takes the transfers lock right after the account lock', async () => {
      const rows = [
        { bookingDate: '2026-04-12', amount: -7_770_003, currency: 'EUR', description: 'lock ing' },
      ];
      await ingestTransactions(a, acc1, rows, { source: 'import' });
      const held = await holdTransfersLock();
      // All rows are duplicates, so only the early lock can make this wait.
      const again = ingestTransactions(a, acc1, rows, { source: 'import' });
      const blocked = await stillPending(again).finally(held.release);
      await held.done;
      expect(await again).toMatchObject({ inserted: 0, duplicates: 1 });
      expect(blocked).toBe(true);
    });
  });

  describe('markTransfer / unlinkTransfer', () => {
    it('links two legs under one group with the transfer category, then unlinks', async () => {
      const out = await manual({ amount: -2_000, description: 'move out' });
      const inn = await manual({ accountId: acc2, amount: 2_000, description: 'move in' });
      await markTransfer(a, out.id, inn.id);
      const [o, i] = [await getTransaction(a, out.id), await getTransaction(a, inn.id)];
      expect(o.transferGroupId).toBeTruthy();
      expect(o.transferGroupId).toBe(i.transferGroupId);
      expect([o.categoryId, i.categoryId]).toEqual([transferCat, transferCat]);
      expect([o.needsReview, i.needsReview]).toEqual([false, false]);
      expect(o.categorisedBy).toBe('user');

      await unlinkTransfer(a, o.transferGroupId!);
      for (const id of [out.id, inn.id]) {
        expect(await getTransaction(a, id)).toMatchObject({
          transferGroupId: null,
          categoryId: null,
          categorisedBy: null,
          needsReview: true,
        });
      }
      await expect(unlinkTransfer(a, o.transferGroupId!)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects invalid pairs', async () => {
      const out = await manual({ amount: -300, description: 'p out' });
      const sameSign = await manual({ accountId: acc2, amount: -300, description: 'p same' });
      const sameAccount = await manual({ amount: 300, description: 'p same acc' });
      const inn = await manual({ accountId: acc2, amount: 300, description: 'p in' });
      await expect(markTransfer(a, out.id, out.id)).rejects.toBeInstanceOf(ValidationError);
      await expect(markTransfer(a, out.id, sameSign.id)).rejects.toBeInstanceOf(ValidationError);
      await expect(markTransfer(a, out.id, sameAccount.id)).rejects.toBeInstanceOf(ValidationError);
      await markTransfer(a, out.id, inn.id);
      const spare = await manual({ accountId: acc2, amount: 300, description: 'p spare' });
      await expect(markTransfer(a, out.id, spare.id)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('isolation and roles', () => {
    let id: string;
    beforeAll(async () => {
      id = (await manual({ description: 'isolated' })).id;
    });

    it('household B gets NotFoundError for every get/update/delete/mark/unlink', async () => {
      await expect(getTransaction(b, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(updateTransaction(b, id, { notes: 'x' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteManualTransaction(b, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(markTransfer(b, id, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        unlinkTransfer(b, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(getTransaction(b, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createManualTransaction(b, {
          accountId: acc1,
          bookingDate: '2026-01-01',
          amount: 1,
          description: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // B cannot use A's category either.
      const bAcc = await createAccount(b, { name: 'B', type: 'checking' });
      await expect(
        createManualTransaction(b, {
          accountId: bAcc.id,
          bookingDate: '2026-01-01',
          amount: 1,
          description: 'x',
          categoryId: food,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // And A's row is untouched.
      const [row] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(schema.transaction).where(eq(schema.transaction.id, id)),
      );
      expect(row!.notes).toBeNull();
    });

    it('viewers can read but every write is forbidden', async () => {
      const v = withRole(a, 'viewer');
      expect((await getTransaction(v, id)).id).toBe(id);
      expect((await listTransactions(v, {})).items.length).toBeGreaterThan(0);
      const writes = [
        createManualTransaction(v, {
          accountId: acc1,
          bookingDate: '2026-01-01',
          amount: 1,
          description: 'x',
        }),
        updateTransaction(v, id, { notes: 'x' }),
        deleteManualTransaction(v, id),
        markTransfer(v, id, id),
        unlinkTransfer(v, '00000000-0000-4000-8000-000000000000'),
      ];
      for (const w of writes) await expect(w).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
