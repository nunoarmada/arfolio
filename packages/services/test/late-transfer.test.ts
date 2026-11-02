import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createRule,
  getTransaction,
  ingestTransactions,
  listCategories,
  matchTransfersForAllHouseholds,
  seedCategoryTemplates,
  unlinkTransfer,
  updateTransaction,
  type IngestRow,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

/**
 * The receiving leg of a transfer often arrives days after the sending leg, by which time the
 * sending leg may already carry an automatic category (rule, merchant memory, AI).
 */
describe('late transfer legs', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let catA: string;
  let catB: string;
  let transferCat: string;

  const row = (over: Partial<IngestRow> = {}): IngestRow => ({
    bookingDate: '2026-10-02',
    amount: -1_250,
    currency: 'EUR',
    description: 'Some Shop',
    ...over,
  });
  const account = async (name: string, institutionName?: string) =>
    (
      await createAccount(a, {
        name,
        type: 'checking',
        ...(institutionName ? { institutionName } : {}),
      })
    ).id;
  const setAi = (id: string, categoryId: string, needsReview: boolean) =>
    withHousehold(a.db, a.householdId, (tx) =>
      tx
        .update(schema.transaction)
        .set({ categoryId, categorisedBy: 'ai', needsReview })
        .where(eq(schema.transaction.id, id)),
    );

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household({ locale: 'en' });
    await seedCategoryTemplates(a, 'en');
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    catA = (await createCategory(a, { groupId: group.id, name: 'A' })).id;
    catB = (await createCategory(a, { groupId: group.id, name: 'B' })).id;
    transferCat = (await listCategories(a))
      .flatMap((g) => g.categories)
      .find((c) => c.templateKey === 'transfer.between_accounts')!.id;
  });
  afterAll(() => t.close());

  it('pairs a leg a user rule categorised when the counter-leg arrives three days later (inside the window)', async () => {
    const from = await account('Rule from');
    const to = await account('Rule to');
    await createRule(a, {
      name: 'joao',
      condition: { descriptionContains: 'joao rule' },
      categoryId: catA,
    });
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'TRANSFER JOAO RULE', amount: -71_001, bookingDate: '2026-10-02' })],
      { source: 'connector' },
    );
    expect(await getTransaction(a, out.insertedIds[0]!)).toMatchObject({
      categoryId: catA,
      categorisedBy: 'rule',
    });
    const inn = await ingestTransactions(
      a,
      to,
      [row({ description: 'TRF RECEBIDA', amount: 71_001, bookingDate: '2026-10-05' })],
      { source: 'connector' },
    );
    for (const id of [out.insertedIds[0]!, inn.insertedIds[0]!]) {
      const leg = await getTransaction(a, id);
      expect(leg).toMatchObject({ categoryId: transferCat, needsReview: false });
      expect(leg.transferGroupId).not.toBeNull();
    }
  });

  it('pairs a leg the AI categorised without confidence (still in review) with its late counter-leg', async () => {
    const from = await account('Ai from');
    const to = await account('Ai to');
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'Joao Silva', amount: -72_001, bookingDate: '2026-10-02' })],
      { source: 'connector' },
    );
    await setAi(out.insertedIds[0]!, catB, true);
    const inn = await ingestTransactions(
      a,
      to,
      [row({ description: 'Joao Silva', amount: 72_001, bookingDate: '2026-10-04' })],
      { source: 'connector' },
    );
    const sent = await getTransaction(a, out.insertedIds[0]!);
    const received = await getTransaction(a, inn.insertedIds[0]!);
    expect(sent.transferGroupId).not.toBeNull();
    expect(sent.transferGroupId).toBe(received.transferGroupId);
    expect(sent).toMatchObject({ categoryId: transferCat, categorisedBy: 'rule' });
  });

  it('pairs a confident AI leg when the late counter-leg names the sending account', async () => {
    const from = await account('Everyday', 'Neobank');
    const to = await account('Savings');
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'Joao Silva', amount: -73_001, bookingDate: '2026-10-02' })],
      { source: 'connector' },
    );
    await setAi(out.insertedIds[0]!, catB, false);
    const inn = await ingestTransactions(
      a,
      to,
      [row({ description: 'Received from Everyday', amount: 73_001, bookingDate: '2026-10-03' })],
      { source: 'connector' },
    );
    expect((await getTransaction(a, out.insertedIds[0]!)).transferGroupId).not.toBeNull();
    expect((await getTransaction(a, inn.insertedIds[0]!)).transferGroupId).not.toBeNull();
  });

  it('still leaves a confident AI purchase and a user-categorised leg alone', async () => {
    const from = await account('Keep from');
    const to = await account('Keep to');
    const out = await ingestTransactions(
      a,
      from,
      [
        row({ description: 'Cafe Central', amount: -74_001, bookingDate: '2026-10-02' }),
        row({ description: 'Joao Silva', amount: -74_002, bookingDate: '2026-10-02' }),
      ],
      { source: 'connector' },
    );
    const [shop, manual] = out.insertedIds as [string, string];
    await setAi(shop, catB, false);
    await updateTransaction(a, manual, { categoryId: catA, applyToMerchant: false });
    await ingestTransactions(
      a,
      to,
      [
        row({ description: 'Joao Silva', amount: 74_001, bookingDate: '2026-10-03' }),
        row({ description: 'Joao Silva', amount: 74_002, bookingDate: '2026-10-03' }),
      ],
      { source: 'connector' },
    );
    for (const id of [shop, manual]) {
      expect((await getTransaction(a, id)).transferGroupId).toBeNull();
    }
    expect(await getTransaction(a, manual)).toMatchObject({
      categoryId: catA,
      categorisedBy: 'user',
    });
  });

  it('pairs at the window edge (5 days) but not beyond it (6 days)', async () => {
    const from = await account('Edge from');
    const to = await account('Edge to');
    const out = await ingestTransactions(
      a,
      from,
      [
        row({ description: 'edge out 5', amount: -75_005, bookingDate: '2026-10-02' }),
        row({ description: 'edge out 6', amount: -75_006, bookingDate: '2026-10-02' }),
      ],
      { source: 'connector' },
    );
    await ingestTransactions(
      a,
      to,
      [
        row({ description: 'edge in 5', amount: 75_005, bookingDate: '2026-10-07' }),
        row({ description: 'edge in 6', amount: 75_006, bookingDate: '2026-10-08' }),
      ],
      { source: 'connector' },
    );
    const [five, six] = out.insertedIds as [string, string];
    expect((await getTransaction(a, five)).transferGroupId).not.toBeNull();
    expect((await getTransaction(a, six)).transferGroupId).toBeNull();
  });

  it('unlinking restores a converted leg with its original category and origin (rule, memory, ai)', async () => {
    const from = await account('Restore from');
    const to = await account('Restore to');
    await createRule(a, {
      name: 'restore rule',
      condition: { descriptionContains: 'restore rule leg' },
      categoryId: catA,
    });
    await withHousehold(a.db, a.householdId, (tx) =>
      tx.insert(schema.merchant).values({
        householdId: a.householdId,
        key: 'RESTORE MEMORY TRANSFER',
        displayName: 'Restore memory',
        defaultCategoryId: catB,
      }),
    );
    const out = await ingestTransactions(
      a,
      from,
      [
        row({ description: 'Transfer restore rule leg', amount: -77_001 }),
        row({ description: 'RESTORE MEMORY TRANSFER', amount: -77_002 }),
        row({ description: 'Transfer restore ai leg', amount: -77_003 }),
      ],
      { source: 'connector' },
    );
    const [ruleId, memoryId, aiId] = out.insertedIds as [string, string, string];
    await setAi(aiId, catB, false);
    await ingestTransactions(
      a,
      to,
      [
        row({ description: 'Transfer in', amount: 77_001, bookingDate: '2026-10-04' }),
        row({ description: 'Transfer in', amount: 77_002, bookingDate: '2026-10-04' }),
        row({ description: 'Transfer in', amount: 77_003, bookingDate: '2026-10-04' }),
      ],
      { source: 'connector' },
    );
    const expected: Array<[string, string, string]> = [
      [ruleId, catA, 'rule'],
      [memoryId, catB, 'memory'],
      [aiId, catB, 'ai'],
    ];
    for (const [id] of expected) {
      const linked = await getTransaction(a, id);
      expect(linked).toMatchObject({ categoryId: transferCat, categorisedBy: 'rule' });
      await unlinkTransfer(a, linked.transferGroupId!);
    }
    for (const [id, cat, by] of expected) {
      expect(await getTransaction(a, id)).toMatchObject({
        categoryId: cat,
        categorisedBy: by,
        transferGroupId: null,
        aiSuggestedCategoryId: null,
        preTransferCategorisedBy: null,
      });
    }
  });

  it('leaves a confident rule leg alone when the partner text is neutral (owner guard)', async () => {
    const from = await account('Guard from');
    const to = await account('Guard to');
    await createRule(a, {
      name: 'guard rule',
      condition: { descriptionContains: 'guard shop' },
      categoryId: catA,
    });
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'Guard shop', amount: -78_001 })],
      { source: 'connector' },
    );
    await ingestTransactions(
      a,
      to,
      [row({ description: 'Joao Silva', amount: 78_001, bookingDate: '2026-10-03' })],
      { source: 'connector' },
    );
    expect((await getTransaction(a, out.insertedIds[0]!)).transferGroupId).toBeNull();
  });

  it('pairs a memory-categorised leg that says transfer with its late counter-leg', async () => {
    const from = await account('Mem from');
    const to = await account('Mem to');
    await withHousehold(a.db, a.householdId, (tx) =>
      tx.insert(schema.merchant).values({
        householdId: a.householdId,
        key: 'TRANSFER MEMORY LATE',
        displayName: 'Memory late',
        defaultCategoryId: catB,
      }),
    );
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'TRANSFER MEMORY LATE', amount: -79_001 })],
      { source: 'connector' },
    );
    expect(await getTransaction(a, out.insertedIds[0]!)).toMatchObject({ categorisedBy: 'memory' });
    await ingestTransactions(
      a,
      to,
      [row({ description: 'Joao Silva', amount: 79_001, bookingDate: '2026-10-05' })],
      { source: 'connector' },
    );
    expect((await getTransaction(a, out.insertedIds[0]!)).transferGroupId).not.toBeNull();
  });

  it('ignores a pending leg', async () => {
    const from = await account('Ign from');
    const to = await account('Ign to');
    const out = await ingestTransactions(
      a,
      from,
      [row({ description: 'pending out', amount: -80_001, status: 'pending' })],
      { source: 'connector' },
    );
    await ingestTransactions(
      a,
      to,
      [row({ description: 'in a', amount: 80_001, bookingDate: '2026-10-03' })],
      { source: 'connector' },
    );
    for (const id of out.insertedIds) {
      expect((await getTransaction(a, id)).transferGroupId).toBeNull();
    }
  });

  describe('matchTransfersForAllHouseholds (repair sweep)', () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    const insertRaw = (
      accountId: string,
      amount: number,
      bookingDate: string,
      extra: Partial<typeof schema.transaction.$inferInsert> = {},
    ) =>
      withHousehold(a.db, a.householdId, async (tx) => {
        const [r] = await tx
          .insert(schema.transaction)
          .values({
            householdId: a.householdId,
            accountId,
            amount,
            bookingDate,
            currency: 'EUR',
            status: 'booked',
            rawDescription: 'raw',
            dedupeHash: `sweep-${accountId}-${amount}-${bookingDate}`,
            source: 'connector',
            needsReview: true,
            ...extra,
          })
          .returning({ id: schema.transaction.id });
        return r!.id;
      });

    it('pairs existing unmatched legs of the last N days, is idempotent, and ignores older rows', async () => {
      const from = await account('Sweep from');
      const to = await account('Sweep to');
      const oldOut = await insertRaw(from, -76_001, day(10), {
        categoryId: catB,
        categorisedBy: 'ai',
      });
      const oldIn = await insertRaw(to, 76_001, day(8));
      const staleOut = await insertRaw(from, -76_002, day(60));
      const staleIn = await insertRaw(to, 76_002, day(59));

      const first = await matchTransfersForAllHouseholds(a.db, { days: 30 });
      expect(first.failed).toEqual([]);
      const out = await getTransaction(a, oldOut);
      expect(out).toMatchObject({ categoryId: transferCat, needsReview: false });
      expect(out.transferGroupId).toBe((await getTransaction(a, oldIn)).transferGroupId);
      expect(out.transferGroupId).not.toBeNull();
      expect((await getTransaction(a, staleOut)).transferGroupId).toBeNull();
      expect((await getTransaction(a, staleIn)).transferGroupId).toBeNull();

      // Ambiguous candidates stay unlinked.
      const ambOut = await insertRaw(from, -76_003, day(6));
      const ambInA = await insertRaw(to, 76_003, day(5));
      const ambInB = await insertRaw(to, 76_003, day(4), { dedupeHash: 'sweep-amb-b' });
      await matchTransfersForAllHouseholds(a.db, { days: 30 });
      for (const id of [ambOut, ambInA, ambInB]) {
        expect((await getTransaction(a, id)).transferGroupId).toBeNull();
      }

      // A currency mismatch never pairs.
      const usdOut = await insertRaw(from, -76_004, day(3), { currency: 'USD' });
      const eurIn = await insertRaw(to, 76_004, day(3));
      await matchTransfersForAllHouseholds(a.db, { days: 30 });
      for (const id of [usdOut, eurIn]) {
        expect((await getTransaction(a, id)).transferGroupId).toBeNull();
      }

      const again = await matchTransfersForAllHouseholds(a.db, { days: 30 });
      expect(again.paired).toBe(0);
      expect((await getTransaction(a, oldOut)).transferGroupId).toBe(out.transferGroupId);
    });
  });
});
