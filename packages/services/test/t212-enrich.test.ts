import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  applyT212Export,
  createCategory,
  createCategoryGroup,
  createRule,
  findT212EnrichmentStart,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { connection, connectionAccount, transaction } = schema;

type Row = {
  ref: string;
  desc?: string;
  date?: string;
  counterparty?: string;
  by?: 'rule' | 'memory' | 'ai' | 'user';
  categoryId?: string;
  transfer?: boolean;
  externalId?: string;
};

describe('Trading 212 export enrichment', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let accountId: string;
  let connectionId: string;
  let food: string;

  beforeAll(async () => {
    t = await startServicesDb();
    await t.owner.insert(schema.user).values({ id: 'user-1', name: 'u', email: 'u@example.test' });
  });
  afterAll(() => t.close());

  async function setUp(provider: 'trading212' | 'enablebanking' = 'trading212') {
    a = await t.household();
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    food = (await createCategory(a, { groupId: group.id, name: 'Food' })).id;
    return withHousehold(a.db, a.householdId, async (tx) => {
      const [acc] = await tx
        .insert(schema.financialAccount)
        .values({ householdId: a.householdId, name: 'T212', type: 'investment' })
        .returning();
      accountId = acc!.id;
      const [conn] = await tx
        .insert(connection)
        .values({
          householdId: a.householdId,
          provider,
          displayName: 'T212',
          status: 'active',
          createdBy: 'user-1',
        })
        .returning();
      connectionId = conn!.id;
      await tx.insert(connectionAccount).values({
        householdId: a.householdId,
        connectionId,
        accountId,
        externalUid: '1',
        externalKey: '1',
        currency: 'EUR',
        name: 'T212',
      });
    });
  }
  beforeEach(() => setUp());

  async function addRows(rows: Row[]): Promise<string[]> {
    return withHousehold(a.db, a.householdId, async (tx) => {
      const out = await tx
        .insert(transaction)
        .values(
          rows.map((r) => ({
            householdId: a.householdId,
            accountId,
            externalId: r.externalId ?? `tx:${r.ref}`,
            dedupeHash: randomUUID(),
            bookingDate: r.date ?? '2026-10-10',
            amount: -450,
            currency: 'EUR',
            status: 'booked' as const,
            rawDescription: r.desc ?? `WITHDRAW ${r.ref}`,
            counterparty: r.counterparty ?? null,
            source: 'connector' as const,
            categoryId: r.categoryId ?? null,
            categorisedBy: r.by ?? null,
            transferGroupId: r.transfer ? randomUUID() : null,
          })),
        )
        .returning({ id: transaction.id });
      return out.map((o) => o.id);
    });
  }

  const load = (id: string) =>
    withHousehold(a.db, a.householdId, async (tx) => {
      const [r] = await tx.select().from(transaction).where(eq(transaction.id, id));
      return r!;
    });
  const enrichedThrough = () =>
    withHousehold(a.db, a.householdId, async (tx) => {
      const [r] = await tx
        .select({ d: connection.t212EnrichedThrough })
        .from(connection)
        .where(eq(connection.id, connectionId));
      return r!.d;
    });
  const input = (
    rows: [string, { merchantName?: string; notes?: string; merchantCategory?: string }][],
    through = '2026-10-28',
  ) => ({
    householdId: a.householdId,
    connectionId,
    rows: new Map(rows),
    through,
  });

  describe('findT212EnrichmentStart', () => {
    it('returns the oldest booking date of WITHDRAW rows without counterparty', async () => {
      await addRows([
        { ref: 'a', date: '2026-10-12' },
        { ref: 'b', date: '2026-10-05' },
        { ref: 'c', date: '2026-09-01', counterparty: 'Known' },
        { ref: 'd', date: '2026-08-01', desc: 'DEPOSIT d' },
        { ref: 'e', date: '2026-07-01', externalId: 'div:e' },
      ]);
      expect(await findT212EnrichmentStart(t.db, a.householdId, connectionId)).toBe('2026-10-05');
    });

    it('ignores rows on or before the enriched-through day', async () => {
      await addRows([
        { ref: 'a', date: '2026-10-12' },
        { ref: 'b', date: '2026-10-05' },
      ]);
      await applyT212Export(t.db, input([], '2026-10-10'));
      expect(await findT212EnrichmentStart(t.db, a.householdId, connectionId)).toBe('2026-10-12');
    });

    it('is null when nothing is left, and for other providers', async () => {
      expect(await findT212EnrichmentStart(t.db, a.householdId, connectionId)).toBeNull();
      await setUp('enablebanking');
      await addRows([{ ref: 'a' }]);
      expect(await findT212EnrichmentStart(t.db, a.householdId, connectionId)).toBeNull();
    });
  });

  describe('applyT212Export', () => {
    it('sets counterparty and description from the merchant name', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      const res = await applyT212Export(t.db, input([['r1', { merchantName: 'Cafe Lisboa' }]]));
      expect(res.updated).toBe(1);
      const row = await load(id!);
      expect(row.counterparty).toBe('Cafe Lisboa');
      expect(row.rawDescription).toBe('Cafe Lisboa');
    });

    it('falls back to the notes for the description only', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      await applyT212Export(t.db, input([['r1', { notes: 'Monthly top up' }]]));
      const row = await load(id!);
      expect(row.rawDescription).toBe('Monthly top up');
      expect(row.counterparty).toBeNull();
    });

    it('skips rows missing from the export and rows that already have a counterparty', async () => {
      const [missing, known] = await addRows([
        { ref: 'm' },
        { ref: 'k', desc: 'Mine', counterparty: 'Mine' },
      ]);
      const res = await applyT212Export(t.db, input([['k', { merchantName: 'Other' }]]));
      expect(res.updated).toBe(0);
      expect((await load(missing!)).rawDescription).toBe('WITHDRAW m');
      expect((await load(known!)).counterparty).toBe('Mine');
    });

    it('stores the merchant category, merging into the details already there', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(transaction)
          .set({ details: { providerType: 'WITHDRAW' } })
          .where(eq(transaction.id, id!)),
      );
      await applyT212Export(
        t.db,
        input([['r1', { merchantName: 'Cafe Lisboa', merchantCategory: 'Restaurants' }]]),
      );
      expect((await load(id!)).details).toEqual({
        providerType: 'WITHDRAW',
        merchantCategory: 'Restaurants',
      });
    });

    it('stores the merchant category on rows that have no details yet', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      await applyT212Export(t.db, input([['r1', { merchantCategory: 'Groceries' }]]));
      expect((await load(id!)).details).toEqual({ merchantCategory: 'Groceries' });
    });

    it('truncates long merchant names', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      await applyT212Export(t.db, input([['r1', { merchantName: 'x'.repeat(1_500) }]]));
      const row = await load(id!);
      expect(row.rawDescription).toHaveLength(1_000);
      expect(row.counterparty).toHaveLength(300);
    });

    it('categorises the updated rows with a rule matching the merchant', async () => {
      await createRule(a, {
        name: 'Cafe',
        condition: { counterpartyContains: 'cafe' },
        categoryId: food,
      });
      const [id] = await addRows([{ ref: 'r1' }]);
      await applyT212Export(t.db, input([['r1', { merchantName: 'Cafe Lisboa' }]]));
      const row = await load(id!);
      expect(row.categoryId).toBe(food);
      expect(row.categorisedBy).toBe('rule');
    });

    it('keeps user categories and does not categorise transfer legs', async () => {
      await createRule(a, {
        name: 'Cafe',
        condition: { counterpartyContains: 'cafe' },
        categoryId: food,
      });
      const group = await createCategoryGroup(a, { name: 'H', kind: 'expense' });
      const other = (await createCategory(a, { groupId: group.id, name: 'Other' })).id;
      const [user, leg] = await addRows([
        { ref: 'u', by: 'user', categoryId: other },
        { ref: 't', transfer: true },
      ]);
      await applyT212Export(
        t.db,
        input([
          ['u', { merchantName: 'Cafe A' }],
          ['t', { merchantName: 'Cafe B' }],
        ]),
      );
      const u = await load(user!);
      expect(u.counterparty).toBe('Cafe A');
      expect(u.categoryId).toBe(other);
      expect(u.categorisedBy).toBe('user');
      expect((await load(leg!)).categoryId).toBeNull();
    });

    it('clears an earlier AI verdict on uncategorised rows so the AI looks again', async () => {
      const [id] = await addRows([{ ref: 'r1' }]);
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(transaction)
          .set({ aiConfidence: 0.3, aiSuggestedCategoryId: food })
          .where(eq(transaction.id, id!)),
      );
      await applyT212Export(t.db, input([['r1', { merchantName: 'Unknown Shop' }]]));
      const row = await load(id!);
      expect(row.aiConfidence).toBeNull();
      expect(row.aiSuggestedCategoryId).toBeNull();
    });

    it('gives named rows a fresh AI judgement: drops AI-set categories and resets the AI counters, keeping user and rule choices', async () => {
      const [ai, user, rule, undone] = await addRows([
        { ref: 'ai', by: 'ai', categoryId: food },
        { ref: 'us', by: 'user', categoryId: food },
        { ref: 'ru', by: 'rule', categoryId: food },
        { ref: 'un' },
      ]);
      await withHousehold(a.db, a.householdId, (tx) =>
        tx
          .update(transaction)
          .set({
            aiAttempts: 3,
            merchantEnrichAttempts: 3,
            merchantEnrichedAt: new Date(),
            needsReview: false,
          })
          .where(eq(transaction.id, ai!)),
      );
      // An AI category the user sent back: capped attempts must stay capped.
      await withHousehold(a.db, a.householdId, (tx) =>
        tx.update(transaction).set({ aiAttempts: 3 }).where(eq(transaction.id, undone!)),
      );
      await applyT212Export(
        t.db,
        input([
          ['ai', { merchantName: 'Unknown Shop' }],
          ['us', { merchantName: 'Unknown Shop' }],
          ['ru', { merchantName: 'Unknown Shop' }],
          ['un', { merchantName: 'Unknown Shop' }],
        ]),
      );
      expect(await load(ai!)).toMatchObject({
        categoryId: null,
        categorisedBy: null,
        confidence: null,
        needsReview: true,
        aiAttempts: 0,
        merchantEnrichAttempts: 0,
        merchantEnrichedAt: null,
      });
      expect(await load(user!)).toMatchObject({ categoryId: food, categorisedBy: 'user' });
      expect(await load(rule!)).toMatchObject({ categoryId: food, categorisedBy: 'rule' });
      expect((await load(undone!)).aiAttempts).toBe(3);
    });

    it('advances enriched-through, never backwards, and is idempotent', async () => {
      await addRows([{ ref: 'r1' }]);
      await applyT212Export(t.db, input([['r1', { merchantName: 'A' }]], '2026-10-28'));
      expect(await enrichedThrough()).toBe('2026-10-28');
      const again = await applyT212Export(
        t.db,
        input([['r1', { merchantName: 'B' }]], '2026-10-01'),
      );
      expect(again.updated).toBe(0);
      expect(await enrichedThrough()).toBe('2026-10-28');
    });
  });
});
