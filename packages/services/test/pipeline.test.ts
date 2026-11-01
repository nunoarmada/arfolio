import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveAccount,
  categorizeTransactions,
  createAccount,
  createCategory,
  createCategoryGroup,
  createRule,
  ForbiddenError,
  getTransaction,
  ingestTransactions,
  listCategories,
  listTransactions,
  matchTransfers,
  NotFoundError,
  seedCategoryTemplates,
  unlinkTransfer,
  updateTransaction,
  ValidationError,
  type IngestRow,
  type ServiceCtx,
} from '../src/index.js';
import { expireVanishedPending } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('ingest pipeline', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let catA: string;
  let catB: string;
  let transferCat: string;

  const row = (over: Partial<IngestRow> = {}): IngestRow => ({
    bookingDate: '2026-07-10',
    amount: -1_250,
    currency: 'EUR',
    description: 'Some Shop',
    ...over,
  });
  const newAccount = async (ctx = a) =>
    (await createAccount(ctx, { name: 'Acc', type: 'checking' })).id;
  const all = (ctx: ServiceCtx = a) =>
    withHousehold(ctx.db, ctx.householdId, (tx) => tx.select().from(schema.transaction));

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household({ locale: 'en' });
    b = await t.household();
    await seedCategoryTemplates(a, 'en');
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    catA = (await createCategory(a, { groupId: group.id, name: 'A' })).id;
    catB = (await createCategory(a, { groupId: group.id, name: 'B' })).id;
    transferCat = (await listCategories(a))
      .flatMap((g) => g.categories)
      .find((c) => c.templateKey === 'transfer.between_accounts')!.id;
  });
  afterAll(() => t.close());

  describe('ingestTransactions', () => {
    it('inserts rows and reports counts and ids', async () => {
      const account = await newAccount();
      const batch = await createBatch(a, account);
      const result = await ingestTransactions(
        a,
        account,
        [
          row({
            description: 'First',
            externalId: 'e1',
            valueDate: '2026-07-11',
            counterparty: 'Cp',
          }),
          row({ description: 'Second', amount: 500 }),
        ],
        { source: 'import', importBatchId: batch },
      );
      expect(result).toMatchObject({ inserted: 2, duplicates: 0, pendingReplaced: 0 });
      expect(result.insertedIds).toHaveLength(2);
      const stored = await getTransaction(a, result.insertedIds[0]!);
      expect(stored).toMatchObject({
        source: 'import',
        status: 'booked',
        importBatchId: batch,
        accountId: account,
      });
      const first = (await all()).find((r) => r.externalId === 'e1')!;
      expect(first).toMatchObject({
        valueDate: '2026-07-11',
        counterparty: 'Cp',
        rawDescription: 'First',
        householdId: a.householdId,
      });
    });

    it('re-ingesting the same rows inserts nothing', async () => {
      const account = await newAccount();
      const rows = [row({ description: 'One' }), row({ description: 'Two', amount: -1 })];
      expect((await ingestTransactions(a, account, rows, { source: 'import' })).inserted).toBe(2);
      const again = await ingestTransactions(a, account, rows, { source: 'import' });
      expect(again).toEqual({ inserted: 0, duplicates: 2, pendingReplaced: 0, insertedIds: [] });
    });

    it('inserts only the new rows of an overlapping file', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ description: 'Old' })], { source: 'import' });
      const r = await ingestTransactions(
        a,
        account,
        [row({ description: 'Old' }), row({ description: 'New', bookingDate: '2026-07-12' })],
        { source: 'import' },
      );
      expect(r).toMatchObject({ inserted: 1, duplicates: 1 });
    });

    it('keeps genuinely repeated rows of one file (occurrences) and still dedupes a re-import', async () => {
      const account = await newAccount();
      const rows = [
        row({ description: 'Coffee' }),
        row({ description: 'Coffee' }),
        row({ description: 'Coffee' }),
      ];
      expect((await ingestTransactions(a, account, rows, { source: 'import' })).inserted).toBe(3);
      expect((await ingestTransactions(a, account, rows, { source: 'import' })).inserted).toBe(0);
      // A later file containing a fourth coffee adds exactly one.
      const four = [...rows, row({ description: 'Coffee' })];
      expect((await ingestTransactions(a, account, four, { source: 'import' })).inserted).toBe(1);
    });

    it('dedupes by external id even when the description differs', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ externalId: 'x1', description: 'v1' })], {
        source: 'connector',
      });
      const r = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'x1', description: 'v2' })],
        { source: 'connector' },
      );
      expect(r).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it('keeps both identical coffees when the newer one arrives first in a later sync, and re-syncing inserts nothing', async () => {
      const account = await newAccount();
      const coffee = (externalId: string) =>
        row({ externalId, description: 'Cafe Central', amount: -120 });
      await ingestTransactions(a, account, [coffee('c-old')], { source: 'connector' });
      // The provider lists the newest first: the new row now sits at occurrence 0.
      const batch = [coffee('c-new'), coffee('c-old')];
      const second = await ingestTransactions(a, account, batch, { source: 'connector' });
      expect(second.inserted).toBe(1);
      const rows = (await all()).filter((r) => r.accountId === account);
      expect(rows.map((r) => r.externalId).sort()).toEqual(['c-new', 'c-old']);
      const again = await ingestTransactions(a, account, batch, { source: 'connector' });
      expect(again).toMatchObject({ inserted: 0, pendingReplaced: 0 });
      expect((await all()).filter((r) => r.accountId === account)).toHaveLength(2);
    });

    it('still treats a connector row as a duplicate of an imported file row with the same data', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ description: 'Cafe Central' })], {
        source: 'import',
      });
      const result = await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Central', externalId: 'x-file' })],
        { source: 'connector' },
      );
      expect(result.inserted).toBe(0);
    });

    it('does not duplicate a transaction when a file id and a connector id describe it', async () => {
      const account = await newAccount();
      await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Fit', externalId: 'FIT-1' })],
        {
          source: 'import',
        },
      );
      const result = await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Fit', externalId: 'eb-1' })],
        { source: 'connector' },
      );
      expect(result.inserted).toBe(0);
      expect((await all()).filter((r) => r.accountId === account)).toHaveLength(1);
    });

    it('does not duplicate a stored row when the provider reissued its external id', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ description: 'Cafe Id', externalId: 'old' })], {
        source: 'connector',
      });
      const again = await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Id', externalId: 'new' })],
        { source: 'connector' },
      );
      expect(again.inserted).toBe(0);
      expect((await all()).filter((r) => r.accountId === account)).toHaveLength(1);
    });

    it('inserts a booked row next to a connector pending row of the same data under another id', async () => {
      const account = await newAccount();
      await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Hold', externalId: 'pend', status: 'pending' })],
        { source: 'connector' },
      );
      const booked = await ingestTransactions(
        a,
        account,
        [row({ description: 'Cafe Hold', externalId: 'book' })],
        { source: 'connector' },
      );
      expect(booked.inserted).toBe(1);
    });

    it('treats the same data on different accounts as different rows', async () => {
      const a1 = await newAccount();
      const a2 = await newAccount();
      expect((await ingestTransactions(a, a1, [row()], { source: 'import' })).inserted).toBe(1);
      expect((await ingestTransactions(a, a2, [row()], { source: 'import' })).inserted).toBe(1);
    });

    it('handles more rows than one insert chunk', async () => {
      const account = await newAccount();
      const rows = Array.from({ length: 1_203 }, (_, i) =>
        row({ description: `Bulk ${i}`, amount: -(i + 1), bookingDate: '2026-02-01' }),
      );
      const first = await ingestTransactions(a, account, rows, { source: 'import' });
      expect(first.inserted).toBe(1_203);
      expect(new Set(first.insertedIds).size).toBe(1_203);
      const again = await ingestTransactions(a, account, rows, { source: 'import' });
      expect(again).toMatchObject({ inserted: 0, duplicates: 1_203 });
    });

    it('replaces a pending row by the booked one with the same external id, keeping user edits', async () => {
      const account = await newAccount();
      const pending = await ingestTransactions(
        a,
        account,
        [
          row({
            externalId: 'p1',
            status: 'pending',
            amount: -1_000,
            description: 'Pending Cafe',
            bookingDate: '2026-07-01',
          }),
        ],
        { source: 'connector' },
      );
      const id = pending.insertedIds[0]!;
      expect(await getTransaction(a, id)).toMatchObject({ status: 'pending' });
      await updateTransaction(a, id, {
        categoryId: catA,
        notes: 'my note',
        applyToMerchant: false,
      });

      const booked = await ingestTransactions(
        a,
        account,
        [
          row({
            externalId: 'p1',
            status: 'booked',
            amount: -1_050,
            description: 'CAFE 123 settled',
            bookingDate: '2026-07-02',
          }),
        ],
        { source: 'connector' },
      );
      expect(booked).toEqual({ inserted: 0, duplicates: 0, pendingReplaced: 1, insertedIds: [] });
      const after = await getTransaction(a, id);
      expect(after).toMatchObject({
        status: 'booked',
        amount: -1_050,
        bookingDate: '2026-07-02',
        rawDescription: 'CAFE 123 settled',
        categoryId: catA,
        categorisedBy: 'user',
        notes: 'my note',
        needsReview: false,
      });
      expect(
        (await all()).filter((r) => r.externalId === 'p1' && r.accountId === account),
      ).toHaveLength(1);

      // Delivering the booked row again is now a plain duplicate.
      const again = await ingestTransactions(
        a,
        account,
        [
          row({
            externalId: 'p1',
            amount: -1_050,
            description: 'CAFE 123 settled',
            bookingDate: '2026-07-02',
          }),
        ],
        { source: 'connector' },
      );
      expect(again).toMatchObject({ inserted: 0, duplicates: 1, pendingReplaced: 0 });
    });

    it('recategorises a replaced pending row that the user had not touched', async () => {
      const account = await newAccount();
      await createRule(a, {
        name: 'r',
        condition: { descriptionContains: 'bookedname' },
        categoryId: catB,
      });
      const p = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'p2', status: 'pending', description: 'PENDING XYZ' })],
        { source: 'connector' },
      );
      expect(await getTransaction(a, p.insertedIds[0]!)).toMatchObject({
        categoryId: null,
        needsReview: true,
      });
      await ingestTransactions(
        a,
        account,
        [row({ externalId: 'p2', status: 'booked', description: 'bookedname final' })],
        { source: 'connector' },
      );
      expect(await getTransaction(a, p.insertedIds[0]!)).toMatchObject({
        categoryId: catB,
        categorisedBy: 'rule',
        needsReview: false,
      });
    });

    it('promotes a pending row without an external id when the booked row has identical data', async () => {
      const account = await newAccount();
      const p = await ingestTransactions(
        a,
        account,
        [row({ status: 'pending', description: 'Floating' })],
        { source: 'connector' },
      );
      await updateTransaction(a, p.insertedIds[0]!, {
        notes: 'kept',
        categoryId: catA,
        applyToMerchant: false,
      });
      const r = await ingestTransactions(
        a,
        account,
        [row({ status: 'booked', valueDate: '2026-07-11', description: 'Floating' })],
        { source: 'connector' },
      );
      expect(r).toEqual({ inserted: 0, duplicates: 0, pendingReplaced: 1, insertedIds: [] });
      expect(await getTransaction(a, p.insertedIds[0]!)).toMatchObject({
        status: 'booked',
        valueDate: '2026-07-11',
        notes: 'kept',
        categoryId: catA,
      });
    });

    it('leaves a pending row without an external id alone when the booked data differs', async () => {
      const account = await newAccount();
      await ingestTransactions(
        a,
        account,
        [row({ status: 'pending', description: 'Hotel hold', amount: -9_000 })],
        { source: 'connector' },
      );
      const r = await ingestTransactions(
        a,
        account,
        [row({ status: 'booked', description: 'Hotel final', amount: -9_500 })],
        { source: 'connector' },
      );
      expect(r).toMatchObject({ inserted: 1, pendingReplaced: 0 });
      const rows = (await all()).filter((x) => x.accountId === account);
      expect(rows.map((x) => x.status).sort()).toEqual(['booked', 'pending']);
    });

    it('is atomic: an invalid row rejects the whole batch', async () => {
      const account = await newAccount();
      await expect(
        ingestTransactions(a, account, [row(), row({ amount: 1.5 })], { source: 'import' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await all()).filter((x) => x.accountId === account)).toHaveLength(0);
    });

    it('rejects unknown, foreign, archived and currency-mismatched targets', async () => {
      const account = await newAccount();
      const other = await newAccount(b);
      await expect(
        ingestTransactions(a, 'nope', [row()], { source: 'import' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        ingestTransactions(a, other, [row()], { source: 'import' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        ingestTransactions(a, account, [row({ currency: 'USD' })], { source: 'import' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        ingestTransactions(a, account, [row()], {
          source: 'import',
          importBatchId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const gone = await newAccount();
      await archiveAccount(a, gone);
      await expect(
        ingestTransactions(a, gone, [row()], { source: 'import' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('is forbidden for viewers and a no-op for an empty batch', async () => {
      const account = await newAccount();
      await expect(
        ingestTransactions(withRole(a, 'viewer'), account, [row()], { source: 'import' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await ingestTransactions(a, account, [], { source: 'import' })).toEqual({
        inserted: 0,
        duplicates: 0,
        pendingReplaced: 0,
        insertedIds: [],
      });
    });
  });

  describe('expireVanishedPending', () => {
    const pending = (over: Partial<IngestRow> = {}) =>
      row({ status: 'pending', bookingDate: '2026-10-10', ...over });

    it('deletes connector pending rows the provider no longer returns, keeping the rest', async () => {
      const account = await newAccount();
      const first = await ingestTransactions(
        a,
        account,
        [
          pending({ externalId: 'v-gone', description: 'Gone' }),
          pending({ externalId: 'v-keep', description: 'Keep' }),
          pending({ description: 'No id keep', amount: -777 }),
          pending({ description: 'No id gone', amount: -778 }),
          pending({ externalId: 'v-edited', description: 'Edited' }),
          pending({ externalId: 'v-old', description: 'Old', bookingDate: '2026-08-01' }),
          row({ externalId: 'v-booked', description: 'Booked', bookingDate: '2026-10-09' }),
        ],
        { source: 'connector' },
      );
      expect(first.inserted).toBe(7);
      await updateTransaction(a, (await all()).find((r) => r.externalId === 'v-edited')!.id, {
        notes: 'mine',
      });
      const returned = [
        pending({ externalId: 'v-keep', description: 'Keep' }),
        pending({ description: 'No id keep', amount: -777 }),
      ];
      const deleted = await expireVanishedPending(a, account, returned, '2026-09-01');
      expect(deleted).toBe(2);
      const left = (await all()).filter((r) => r.accountId === account);
      expect(left.map((r) => r.rawDescription).sort()).toEqual(
        ['Booked', 'Edited', 'Keep', 'No id keep', 'Old'].sort(),
      );
    });

    it('never touches booked, manual or imported rows, or other accounts', async () => {
      const account = await newAccount();
      const other = await newAccount();
      await ingestTransactions(a, account, [pending({ description: 'Imported pending' })], {
        source: 'import',
      });
      await ingestTransactions(a, other, [pending({ externalId: 'o1' })], { source: 'connector' });
      expect(await expireVanishedPending(a, account, [], '2026-09-01')).toBe(0);
      expect((await all()).filter((r) => r.accountId === other)).toHaveLength(1);
      expect((await all()).filter((r) => r.accountId === account)).toHaveLength(1);
    });
  });

  describe('categorisation', () => {
    it('rules beat merchant memory', async () => {
      const ctx = await t.household();
      const g = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
      const rc = (await createCategory(ctx, { groupId: g.id, name: 'ByRule' })).id;
      const mc = (await createCategory(ctx, { groupId: g.id, name: 'ByMemory' })).id;
      const account = await newAccount(ctx);
      await createRule(ctx, {
        name: 'r',
        condition: { descriptionContains: 'tesco' },
        categoryId: rc,
      });
      await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.insert(schema.merchant).values({
          householdId: ctx.householdId,
          key: 'TESCO',
          displayName: 'Tesco',
          defaultCategoryId: mc,
        }),
      );
      const r = await ingestTransactions(ctx, account, [row({ description: 'TESCO 1234' })], {
        source: 'import',
      });
      expect(await getTransaction(ctx, r.insertedIds[0]!)).toMatchObject({
        categoryId: rc,
        categorisedBy: 'rule',
        needsReview: false,
      });
    });

    it('uses merchant memory when no rule matches, and flags the rest for review', async () => {
      const ctx = await t.household();
      const g = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
      const mc = (await createCategory(ctx, { groupId: g.id, name: 'ByMemory' })).id;
      const account = await newAccount(ctx);
      await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.insert(schema.merchant).values({
          householdId: ctx.householdId,
          key: 'CAFE LUA',
          displayName: 'Cafe Lua',
          defaultCategoryId: mc,
        }),
      );
      const r = await ingestTransactions(
        ctx,
        account,
        [
          row({ description: 'COMPRA CAFE LUA 01/02' }),
          row({ description: 'Mystery Vendor', amount: -3 }),
        ],
        { source: 'import' },
      );
      const rows = await Promise.all(r.insertedIds.map((id) => getTransaction(ctx, id)));
      const mem = rows.find((x) => x.rawDescription.includes('LUA'))!;
      const mystery = rows.find((x) => x.rawDescription === 'Mystery Vendor')!;
      expect(mem).toMatchObject({ categoryId: mc, categorisedBy: 'memory', needsReview: false });
      expect(mem.merchantId).not.toBeNull();
      expect(mystery).toMatchObject({ categoryId: null, needsReview: true });
    });

    it('applies memory to later rows after a user correction', async () => {
      const account = await newAccount();
      const first = await ingestTransactions(
        a,
        account,
        [row({ description: 'PADARIA SOL 111111' })],
        { source: 'import' },
      );
      const id = first.insertedIds[0]!;
      expect(await getTransaction(a, id)).toMatchObject({ categoryId: null, needsReview: true });
      await updateTransaction(a, id, { categoryId: catA });
      const next = await ingestTransactions(
        a,
        account,
        [row({ description: 'PADARIA SOL 222222', bookingDate: '2026-07-20' })],
        { source: 'import' },
      );
      expect(await getTransaction(a, next.insertedIds[0]!)).toMatchObject({
        categoryId: catA,
        categorisedBy: 'memory',
        needsReview: false,
      });
    });

    it('categorizeTransactions never overrides a user choice', async () => {
      const account = await newAccount();
      await createRule(a, {
        name: 'r2',
        condition: { descriptionContains: 'userwins' },
        categoryId: catB,
      });
      const r = await ingestTransactions(a, account, [row({ description: 'userwins 1' })], {
        source: 'import',
      });
      const id = r.insertedIds[0]!;
      await updateTransaction(a, id, { categoryId: catA, applyToMerchant: false });
      await categorizeTransactions(a, [id]);
      expect(await getTransaction(a, id)).toMatchObject({
        categoryId: catA,
        categorisedBy: 'user',
      });
    });

    it('categorizeTransactions is forbidden for viewers and scoped to the household', async () => {
      const account = await newAccount();
      const r = await ingestTransactions(a, account, [row({ description: 'scope check' })], {
        source: 'import',
      });
      await expect(
        categorizeTransactions(withRole(a, 'viewer'), r.insertedIds),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await categorizeTransactions(b, r.insertedIds); // other household: ids are invisible, nothing happens
      expect(await getTransaction(a, r.insertedIds[0]!)).toMatchObject({ needsReview: true });
    });
  });

  describe('transfer pairing', () => {
    it('pairs the legs once both exist, with a shared group and the transfer category', async () => {
      const from = await newAccount();
      const to = await newAccount();
      const out = await ingestTransactions(
        a,
        from,
        [row({ description: 'TRF savings', amount: -50_000, bookingDate: '2026-08-01' })],
        { source: 'import' },
      );
      expect(await getTransaction(a, out.insertedIds[0]!)).toMatchObject({
        transferGroupId: null,
        needsReview: true,
      });

      const inn = await ingestTransactions(
        a,
        to,
        [row({ description: 'Deposit from checking', amount: 50_000, bookingDate: '2026-08-02' })],
        { source: 'import' },
      );
      const [o, i] = [
        await getTransaction(a, out.insertedIds[0]!),
        await getTransaction(a, inn.insertedIds[0]!),
      ];
      expect(o.transferGroupId).toBeTruthy();
      expect(o.transferGroupId).toBe(i.transferGroupId);
      expect([o.categoryId, i.categoryId]).toEqual([transferCat, transferCat]);
      expect([o.needsReview, i.needsReview]).toEqual([false, false]);
    });

    it('pairs legs ingested separately for different accounts several days apart', async () => {
      const from = await newAccount();
      const to = await newAccount();
      await ingestTransactions(
        a,
        from,
        [row({ description: 'x', amount: -777_001, bookingDate: '2026-08-10' })],
        { source: 'import' },
      );
      await ingestTransactions(
        a,
        to,
        [row({ description: 'y', amount: 777_001, bookingDate: '2026-08-12' })],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 777_001);
      expect(legs).toHaveLength(2);
      expect(new Set(legs.map((l) => l.transferGroupId)).size).toBe(1);
    });

    it('leaves ambiguous legs unlinked and flagged for review', async () => {
      const from = await newAccount();
      const to = await newAccount();
      await ingestTransactions(
        a,
        from,
        [
          row({ description: 'out one', amount: -4_321, bookingDate: '2026-08-05' }),
          row({ description: 'out two', amount: -4_321, bookingDate: '2026-08-06' }),
        ],
        { source: 'import' },
      );
      await ingestTransactions(
        a,
        to,
        [row({ description: 'in', amount: 4_321, bookingDate: '2026-08-06' })],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 4_321);
      expect(legs).toHaveLength(3);
      for (const leg of legs) {
        expect(leg).toMatchObject({ transferGroupId: null, needsReview: true });
      }
    });

    it('does not pair legs beyond the window, on the same account, or already categorised', async () => {
      const from = await newAccount();
      const to = await newAccount();
      await ingestTransactions(
        a,
        from,
        [
          row({ description: 'far out', amount: -111_001, bookingDate: '2026-09-01' }),
          row({ description: 'same acc out', amount: -222_001, bookingDate: '2026-09-01' }),
          row({ description: 'same acc in', amount: 222_001, bookingDate: '2026-09-01' }),
        ],
        { source: 'import' },
      );
      await createRule(a, {
        name: 'cat',
        condition: { descriptionContains: 'ruled in' },
        categoryId: catA,
      });
      await ingestTransactions(
        a,
        to,
        [
          row({ description: 'far in', amount: 111_001, bookingDate: '2026-09-09' }),
          row({ description: 'ruled in', amount: 333_001, bookingDate: '2026-09-01' }),
        ],
        { source: 'import' },
      );
      await ingestTransactions(
        a,
        from,
        [row({ description: 'ruled partner', amount: -333_001, bookingDate: '2026-09-01' })],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) =>
        [111_001, 222_001, 333_001].includes(Math.abs(r.amount)),
      );
      expect(legs.every((l) => l.transferGroupId === null)).toBe(true);
    });

    it('pairs a leg that memory or AI already categorised once the counter-leg arrives, but never a user-categorised one', async () => {
      const from = await newAccount();
      const to = await newAccount();
      await withHousehold(a.db, a.householdId, (tx) =>
        tx.insert(schema.merchant).values({
          householdId: a.householdId,
          key: 'REVOLUT TOPUP',
          displayName: 'Revolut topup',
          defaultCategoryId: catA,
        }),
      );
      const out = await ingestTransactions(
        a,
        from,
        [
          row({ description: 'REVOLUT TOPUP', amount: -55_001, bookingDate: '2026-10-05' }),
          row({ description: 'Transfer ai leg', amount: -55_002, bookingDate: '2026-10-05' }),
          row({ description: 'user leg', amount: -55_003, bookingDate: '2026-10-05' }),
        ],
        { source: 'import' },
      );
      const [memoryId, aiId, userId] = out.insertedIds as [string, string, string];
      expect(await getTransaction(a, memoryId)).toMatchObject({
        categoryId: catA,
        categorisedBy: 'memory',
      });
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catB, categorisedBy: 'ai', needsReview: true })
          .where(eq(schema.transaction.id, aiId)),
      );
      await updateTransaction(a, userId, { categoryId: catA, applyToMerchant: false });
      await ingestTransactions(
        a,
        to,
        [
          row({ description: 'in one', amount: 55_001, bookingDate: '2026-10-06' }),
          row({ description: 'in two', amount: 55_002, bookingDate: '2026-10-06' }),
          row({ description: 'in three', amount: 55_003, bookingDate: '2026-10-06' }),
        ],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) =>
        [55_001, 55_002, 55_003].includes(Math.abs(r.amount)),
      );
      for (const leg of legs.filter((l) => Math.abs(l.amount) !== 55_003)) {
        expect(leg).toMatchObject({
          categoryId: transferCat,
          categorisedBy: 'rule',
          needsReview: false,
        });
        expect(leg.transferGroupId).not.toBeNull();
      }
      for (const leg of legs.filter((l) => Math.abs(l.amount) === 55_003)) {
        expect(leg.transferGroupId).toBeNull();
      }
    });

    it('never pairs a categorised purchase with an unrelated deposit of the same amount', async () => {
      const card = await newAccount();
      const other = await newAccount();
      const out = await ingestTransactions(
        a,
        card,
        [row({ description: 'Restaurante O Tacho', amount: -2_500, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catA, categorisedBy: 'ai', needsReview: false })
          .where(eq(schema.transaction.id, out.insertedIds[0]!)),
      );
      await ingestTransactions(
        a,
        other,
        [row({ description: 'MB WAY Joao Silva', amount: 2_500, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 2_500);
      expect(legs).toHaveLength(2);
      for (const leg of legs) expect(leg.transferGroupId).toBeNull();
      // The purchase keeps its category and review state; the deposit stays uncategorised.
      expect(legs.find((l) => l.amount < 0)).toMatchObject({
        categoryId: catA,
        needsReview: false,
      });
    });

    it('does not let a categorised look-alike make an uncategorised pair ambiguous', async () => {
      const from = await newAccount();
      const to = await newAccount();
      const noise = await ingestTransactions(
        a,
        from,
        [row({ description: 'Padaria Sol', amount: -6_100, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catA, categorisedBy: 'ai', needsReview: false })
          .where(eq(schema.transaction.id, noise.insertedIds[0]!)),
      );
      await ingestTransactions(
        a,
        from,
        [row({ description: 'Transfer out', amount: -6_100, bookingDate: '2026-10-06' })],
        { source: 'import' },
      );
      await ingestTransactions(
        a,
        to,
        [row({ description: 'Transfer in', amount: 6_100, bookingDate: '2026-10-06' })],
        { source: 'import' },
      );
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 6_100);
      expect(legs.filter((l) => l.transferGroupId !== null)).toHaveLength(2);
      expect(legs.find((l) => l.rawDescription === 'Padaria Sol')).toMatchObject({
        transferGroupId: null,
        categoryId: catA,
        needsReview: false,
      });
    });

    it('pairs an AI-categorised leg that names the other account, and unlinking restores its category', async () => {
      const mainAcct = (
        await createAccount(a, { name: 'Main', type: 'checking', institutionName: 'Neobank' })
      ).id;
      const broker = (
        await createAccount(a, {
          name: 'Broker',
          type: 'investment',
          institutionName: 'Trading 212',
        })
      ).id;
      const out = await ingestTransactions(
        a,
        mainAcct,
        [row({ description: 'To Trading 212', amount: -20_000, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      const outId = out.insertedIds[0]!;
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catB, categorisedBy: 'ai', needsReview: false })
          .where(eq(schema.transaction.id, outId)),
      );
      const inn = await ingestTransactions(
        a,
        broker,
        [row({ description: 'DEPOSIT abc123', amount: 20_000, bookingDate: '2026-10-05' })],
        { source: 'connector' },
      );
      const paired = await getTransaction(a, outId);
      expect(paired).toMatchObject({ categoryId: transferCat, categorisedBy: 'rule' });
      expect(paired.transferGroupId).not.toBeNull();

      await unlinkTransfer(a, paired.transferGroupId!);
      const restored = (await all()).find((r) => r.id === outId)!;
      expect(restored).toMatchObject({
        categoryId: catB,
        categorisedBy: 'ai',
        transferGroupId: null,
        transferLocked: true,
        aiSuggestedCategoryId: null,
      });
      // The restore does not mark the row as edited, so the AI may still judge it later.
      expect(restored.userEditedAt).toBeNull();
      // The deposit had no category: it goes back to review as before.
      const deposit = (await all()).find((r) => r.id === inn.insertedIds[0])!;
      expect(deposit).toMatchObject({ categoryId: null, transferGroupId: null });
    });

    it('pairs "To Trading212" with a platform DEPOSIT when both legs were categorised by the AI', async () => {
      const bank = (await createAccount(a, { name: 'Main account', type: 'checking' })).id;
      const broker = (
        await createAccount(a, {
          name: 'Broker',
          type: 'investment',
          institutionName: 'Trading 212',
        })
      ).id;
      const out = await ingestTransactions(
        a,
        bank,
        [row({ description: 'To Trading212', amount: -30_000, bookingDate: '2026-10-05' })],
        { source: 'connector' },
      );
      const inn = await ingestTransactions(
        a,
        broker,
        [
          row({
            description: 'DEPOSIT ref1',
            amount: 30_000,
            bookingDate: '2026-10-05',
            externalId: 'tx:ref1',
            details: { providerType: 'DEPOSIT' },
          }),
        ],
        { source: 'connector' },
      );
      const ids = [out.insertedIds[0]!, inn.insertedIds[0]!];
      expect((await getTransaction(a, ids[0]!)).transferGroupId).not.toBeNull();
      expect((await getTransaction(a, ids[1]!)).transferGroupId).not.toBeNull();
    });

    it('pairs AI-categorised legs of that kind arriving after the AI sweep', async () => {
      const bank = (await createAccount(a, { name: 'Bank X', type: 'checking' })).id;
      const broker = (
        await createAccount(a, {
          name: 'Broker 2',
          type: 'investment',
          institutionName: 'Trading 212',
        })
      ).id;
      const out = await ingestTransactions(
        a,
        bank,
        [row({ description: 'To Trading212', amount: -40_000, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      const inn = await ingestTransactions(
        a,
        broker,
        [row({ description: 'DEPOSIT ref2', amount: 40_000, bookingDate: '2026-10-05' })],
        { source: 'import' },
      );
      // They paired on arrival; undo that and let the AI categorise both, then match again.
      const [o, i] = [out.insertedIds[0]!, inn.insertedIds[0]!];
      await unlinkTransfer(a, (await getTransaction(a, o)).transferGroupId!);
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catB, categorisedBy: 'ai', needsReview: false, transferLocked: false })
          .where(eq(schema.transaction.accountId, bank)),
      );
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: catA, categorisedBy: 'ai', needsReview: false, transferLocked: false })
          .where(eq(schema.transaction.accountId, broker)),
      );
      expect(await matchTransfers(a, { since: '2026-10-01' })).toMatchObject({ paired: 1 });
      expect((await getTransaction(a, i)).categoryId).toBe(transferCat);
    });

    it('matchTransfers honours `since` and never pairs rows before it', async () => {
      const from = await newAccount();
      const to = await newAccount();
      // Insert directly so ingest does not pair them first.
      await withHousehold(a.db, a.householdId, (tx) =>
        tx.insert(schema.transaction).values(
          [
            { accountId: from, amount: -9_001, dedupeHash: 'm1' },
            { accountId: to, amount: 9_001, dedupeHash: 'm2' },
          ].map((x) => ({
            ...x,
            householdId: a.householdId,
            bookingDate: '2026-01-05',
            currency: 'EUR',
            status: 'booked' as const,
            rawDescription: 'raw',
            source: 'import' as const,
            needsReview: true,
          })),
        ),
      );
      expect(await matchTransfers(a, { since: '2026-02-01' })).toMatchObject({ paired: 0 });
      expect(await matchTransfers(a, { since: '2026-01-01' })).toMatchObject({ paired: 1 });
      expect(await matchTransfers(a, { since: '2026-01-01' })).toMatchObject({ paired: 0 });
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 9_001);
      expect(new Set(legs.map((l) => l.transferGroupId)).size).toBe(1);
      expect(legs[0]!.transferGroupId).not.toBeNull();
    });

    it('does not re-pair legs the user unlinked when overlapping rows are re-ingested', async () => {
      const from = await newAccount();
      const to = await newAccount();
      const outRows = [
        row({ description: 'unl out', amount: -616_001, bookingDate: '2026-10-01' }),
      ];
      const inRows = [row({ description: 'unl in', amount: 616_001, bookingDate: '2026-10-02' })];
      const o = await ingestTransactions(a, from, outRows, { source: 'import' });
      await ingestTransactions(a, to, inRows, { source: 'import' });
      const groupId = (await getTransaction(a, o.insertedIds[0]!)).transferGroupId!;
      expect(groupId).toBeTruthy();
      await unlinkTransfer(a, groupId);
      await ingestTransactions(
        a,
        from,
        [...outRows, row({ description: 'unl more', bookingDate: '2026-10-02' })],
        { source: 'import' },
      );
      await ingestTransactions(a, to, inRows, { source: 'import' });
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 616_001);
      expect(legs).toHaveLength(2);
      expect(legs.every((l) => l.transferGroupId === null && l.needsReview)).toBe(true);
    });

    it('matchTransfers is forbidden for viewers', async () => {
      await expect(
        matchTransfers(withRole(a, 'viewer'), { since: '2026-01-01' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('concurrency', () => {
    it('two concurrent ingests of the same rows on one account insert them once, without error', async () => {
      const account = await newAccount();
      const rows = Array.from({ length: 50 }, (_, i) =>
        row({ description: `Race ${i}`, amount: -(i + 1) * 1_000_003, externalId: `race-${i}` }),
      );
      const results = await Promise.all([
        ingestTransactions(a, account, rows, { source: 'connector' }),
        ingestTransactions(a, account, rows, { source: 'connector' }),
      ]);
      expect(results.map((r) => r.inserted).sort((x, y) => x - y)).toEqual([0, 50]);
      expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(50);
      expect((await all()).filter((r) => r.accountId === account)).toHaveLength(50);
    });

    it('concurrent ingests on different accounts never put one leg in two groups', async () => {
      const from = await newAccount();
      const to1 = await newAccount();
      const to2 = await newAccount();
      await ingestTransactions(
        a,
        from,
        [row({ description: 'X leg', amount: -909_001, bookingDate: '2026-11-01' })],
        { source: 'import' },
      );
      await Promise.all([
        ingestTransactions(
          a,
          to1,
          [row({ description: 'in one', amount: 909_001, bookingDate: '2026-11-01' })],
          { source: 'import' },
        ),
        ingestTransactions(
          a,
          to2,
          [row({ description: 'in two', amount: 909_001, bookingDate: '2026-11-02' })],
          { source: 'import' },
        ),
      ]);
      const legs = (await all()).filter((r) => Math.abs(r.amount) === 909_001);
      const grouped = legs.filter((l) => l.transferGroupId);
      expect(grouped).toHaveLength(2);
      expect(new Set(grouped.map((l) => l.transferGroupId)).size).toBe(1);
      expect(grouped.some((l) => l.amount < 0)).toBe(true);
      expect(grouped.some((l) => l.amount > 0)).toBe(true);
    });
  });

  describe('transaction details', () => {
    const details = {
      remittance: ['Line one'],
      reference: 'REF-1',
      bankCode: { code: 'PMNT' },
    };
    const extras = {
      transactionDate: '2026-07-09',
      occurredAt: '2026-07-09T14:30:00.000Z',
      mcc: '5411',
      details,
    };
    const byExternalId = async (externalId: string) =>
      (await all()).find((r) => r.externalId === externalId)!;

    it('stores transaction date, time, mcc and details on insert', async () => {
      const account = await newAccount();
      const result = await ingestTransactions(a, account, [row({ externalId: 'td1', ...extras })], {
        source: 'connector',
      });
      expect(result.inserted).toBe(1);
      const stored = await getTransaction(a, result.insertedIds[0]!);
      expect(stored.transactionDate).toBe('2026-07-09');
      expect(stored.occurredAt?.toISOString()).toBe('2026-07-09T14:30:00.000Z');
      expect(stored.mcc).toBe('5411');
      expect(stored.details).toEqual(details);
    });

    it('leaves the columns null when the source gives nothing (file imports)', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ externalId: 'td0' })], { source: 'import' });
      expect(await byExternalId('td0')).toMatchObject({
        transactionDate: null,
        occurredAt: null,
        mcc: null,
        details: null,
      });
    });

    it('drops invalid values instead of rejecting the row', async () => {
      const account = await newAccount();
      const result = await ingestTransactions(
        a,
        account,
        [
          row({
            externalId: 'bad1',
            transactionDate: 'yesterday',
            occurredAt: 'noon',
            mcc: '54x1',
            details: { note: 'kept', bankCode: 'nope', rogue: 1 } as never,
          }),
        ],
        { source: 'connector' },
      );
      expect(result.inserted).toBe(1);
      expect(await byExternalId('bad1')).toMatchObject({
        transactionDate: null,
        occurredAt: null,
        mcc: null,
        details: { note: 'kept' },
      });
    });

    it('backfills nulls on a re-ingest of the same external id without counting an insert', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ externalId: 'bf1' })], { source: 'connector' });
      const before = await byExternalId('bf1');
      const again = await ingestTransactions(a, account, [row({ externalId: 'bf1', ...extras })], {
        source: 'connector',
      });
      expect(again).toEqual({ inserted: 0, duplicates: 1, pendingReplaced: 0, insertedIds: [] });
      const after = await byExternalId('bf1');
      expect(after).toMatchObject({
        transactionDate: '2026-07-09',
        mcc: '5411',
        details,
        amount: before.amount,
        rawDescription: before.rawDescription,
        dedupeHash: before.dedupeHash,
      });
      expect(after.occurredAt?.toISOString()).toBe('2026-07-09T14:30:00.000Z');
    });

    it('never overwrites stored values or user edits when backfilling', async () => {
      const account = await newAccount();
      const first = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'bf2', transactionDate: '2026-07-01', mcc: '5812', details })],
        { source: 'connector' },
      );
      await updateTransaction(a, first.insertedIds[0]!, { categoryId: catA, notes: 'mine' });
      await ingestTransactions(
        a,
        account,
        [
          row({
            externalId: 'bf2',
            description: 'Changed',
            amount: -9_999,
            ...extras,
            details: { note: 'other' },
          }),
        ],
        { source: 'connector' },
      );
      const after = await byExternalId('bf2');
      expect(after).toMatchObject({
        transactionDate: '2026-07-01',
        mcc: '5812',
        details,
        rawDescription: 'Some Shop',
        amount: -1_250,
        categoryId: catA,
        notes: 'mine',
      });
      // Only the null column is filled.
      expect(after.occurredAt?.toISOString()).toBe('2026-07-09T14:30:00.000Z');
    });

    it('keeps and updates the columns when a pending row becomes booked', async () => {
      const account = await newAccount();
      const pending = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'pb1', status: 'pending', mcc: '5411', details: { note: 'held' } })],
        { source: 'connector' },
      );
      const booked = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'pb1', status: 'booked', transactionDate: '2026-07-09', details })],
        { source: 'connector' },
      );
      expect(booked.pendingReplaced).toBe(1);
      const stored = await getTransaction(a, pending.insertedIds[0]!);
      expect(stored).toMatchObject({
        status: 'booked',
        mcc: '5411',
        transactionDate: '2026-07-09',
        details: { note: 'held', ...details },
      });
    });

    it('reads a malformed stored details value as null in the detail view', async () => {
      const account = await newAccount();
      const r = await ingestTransactions(a, account, [row({ externalId: 'mf1' })], {
        source: 'connector',
      });
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ details: { rogue: [1] } })
          .where(eq(schema.transaction.id, r.insertedIds[0]!)),
      );
      expect((await getTransaction(a, r.insertedIds[0]!)).details).toBeNull();
    });

    it('keeps the stored details when a booked merge would exceed the size cap', async () => {
      const account = await newAccount();
      const big = { remittance: Array.from({ length: 10 }, () => 'x'.repeat(500)) };
      const pending = await ingestTransactions(
        a,
        account,
        [row({ externalId: 'cap1', status: 'pending', details: big })],
        { source: 'connector' },
      );
      await ingestTransactions(
        a,
        account,
        [row({ externalId: 'cap1', status: 'booked', details: { note: 'n'.repeat(1_000) } })],
        { source: 'connector' },
      );
      expect((await getTransaction(a, pending.insertedIds[0]!)).details).toEqual(big);
    });

    it('keeps the list payload small: occurredAt and mcc, no details', async () => {
      const account = await newAccount();
      await ingestTransactions(a, account, [row({ externalId: 'ls1', ...extras })], {
        source: 'connector',
      });
      const page = await listTransactions(a, { accountIds: [account] });
      const item = page.items[0]!;
      expect(item.mcc).toBe('5411');
      expect(item.occurredAt?.toISOString()).toBe('2026-07-09T14:30:00.000Z');
      expect('details' in item).toBe(false);
    });
  });

  it('listTransactions sees what ingest stored', async () => {
    const account = await newAccount();
    await ingestTransactions(a, account, [row({ description: 'Listed row' })], {
      source: 'import',
    });
    expect((await listTransactions(a, { accountIds: [account] })).items).toHaveLength(1);
  });
});

async function createBatch(ctx: ServiceCtx, accountId: string): Promise<string> {
  const [batch] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .insert(schema.importBatch)
      .values({
        householdId: ctx.householdId,
        accountId,
        source: 'csv',
        filename: 'f.csv',
        createdBy: ctx.userId,
      })
      .returning(),
  );
  return batch!.id;
}
