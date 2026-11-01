import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db, type Tx } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

/** Drizzle wraps driver errors ("Failed query"); the Postgres message is on `cause`. */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  }
  throw new Error('expected the query to be rejected');
}

// Tables with a single `id` primary key; budget_line_category and budget_amount have composite
// keys and get their own household checks below.
const ID_TABLES = ['budget', 'budget_line', 'recurring'] as const;
const ALL_TABLES = [
  ...ID_TABLES,
  'budget_line_category',
  'budget_amount',
  'investment_bucket',
  'investment_bucket_snapshot',
  'budget_line_bucket',
] as const;

interface Seed {
  accountId: string;
  groupId: string;
  categoryId: string;
  budgetId: string;
  budgetLineId: string;
  recurringId: string;
}

async function seed(tx: Tx, h: string): Promise<Seed> {
  const [group] = await tx
    .insert(schema.categoryGroup)
    .values({ householdId: h, name: 'Home', kind: 'expense' })
    .returning();
  const [category] = await tx
    .insert(schema.category)
    .values({ householdId: h, groupId: group!.id, name: 'Rent' })
    .returning();
  const [account] = await tx
    .insert(schema.financialAccount)
    .values({ householdId: h, name: 'Main', type: 'checking' })
    .returning();
  const [budget] = await tx
    .insert(schema.budget)
    .values({ householdId: h, startMonth: '2026-01-01', name: '2026', createdBy: 'u1' })
    .returning();
  const [line] = await tx
    .insert(schema.budgetLine)
    .values({
      householdId: h,
      budgetId: budget!.id,
      kind: 'expense',
      name: 'Housing',
      groupId: group!.id,
      accountId: account!.id,
      position: 0,
    })
    .returning();
  await tx.insert(schema.budgetLineCategory).values({
    householdId: h,
    budgetLineId: line!.id,
    budgetId: budget!.id,
    categoryId: category!.id,
  });
  await tx
    .insert(schema.budgetAmount)
    .values({ householdId: h, budgetLineId: line!.id, monthIndex: 1, amount: 50000 });
  const [rec] = await tx
    .insert(schema.recurring)
    .values({
      householdId: h,
      accountId: account!.id,
      merchantKey: 'landlord',
      name: 'Rent',
      amount: -50000,
      currency: 'EUR',
      cadence: 'monthly',
      status: 'detected',
      source: 'detected',
      categoryId: category!.id,
      budgetLineId: line!.id,
    })
    .returning();
  return {
    accountId: account!.id,
    groupId: group!.id,
    categoryId: category!.id,
    budgetId: budget!.id,
    budgetLineId: line!.id,
    recurringId: rec!.id,
  };
}

describe('phase 3 schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    a = await withHousehold(db, 'hA', (tx) => seed(tx, 'hA'));
    b = await withHousehold(db, 'hB', (tx) => seed(tx, 'hB'));
    await withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.householdSettings).values({ householdId: 'hA' }),
    );
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  const idTables = () =>
    ({
      budget: [schema.budget, 'budgetId', { name: 'x' }],
      budget_line: [schema.budgetLine, 'budgetLineId', { notes: 'x' }],
      recurring: [schema.recurring, 'recurringId', { name: 'x' }],
    }) as const;

  // FORCE ROW LEVEL SECURITY is intentionally not used (repo convention, see 0001).
  it.each(ALL_TABLES)('%s has RLS enabled with a household_isolation policy', async (table) => {
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, (select count(*)::int from pg_policies p
          where p.tablename = c.relname and p.policyname = 'household_isolation') as policies
          from pg_class c where c.relname = ${table} and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]).toMatchObject({ rls: true, policies: 1 });
  });

  it.each(ALL_TABLES)(
    '%s: policy USING and WITH CHECK use the household setting',
    async (table) => {
      const expected = "(household_id = current_setting('app.household_id'::text, true))";
      const { rows } = await db.execute(
        sql`select qual, with_check from pg_policies
          where tablename = ${table} and policyname = 'household_isolation'`,
      );
      expect(rows).toEqual([{ qual: expected, with_check: expected }]);
    },
  );

  it.each(ALL_TABLES)('%s: no rows visible outside withHousehold', async (table) => {
    const { rows } = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it.each(ID_TABLES)('%s: moving an own row to another household is rejected', async (table) => {
    const [tbl, key] = idTables()[table];
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(tbl as unknown as PgTable)
          .set({ householdId: 'hB' } as never)
          .where(eq((tbl as unknown as { id: PgColumn }).id, a[key])),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it.each(ID_TABLES)('%s: household A cannot see, update or delete B rows', async (table) => {
    const [tbl, key, patch] = idTables()[table];
    const t = tbl as unknown as PgTable;
    const idCol = (tbl as unknown as { id: PgColumn }).id;
    const bId = b[key];
    expect(
      await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(idCol, bId))),
    ).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(t)
        .set(patch as never)
        .where(eq(idCol, bId))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withHousehold(db, 'hA', (tx) =>
      tx.delete(t).where(eq(idCol, bId)).returning(),
    );
    expect(deleted).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(idCol, bId))),
    ).toHaveLength(1);
  });

  it('budget_line_category and budget_amount: A cannot see, update or delete B rows', async () => {
    const seenLinks = await withHousehold(db, 'hA', (tx) =>
      tx
        .select()
        .from(schema.budgetLineCategory)
        .where(eq(schema.budgetLineCategory.budgetLineId, b.budgetLineId)),
    );
    expect(seenLinks).toEqual([]);
    const seenAmounts = await withHousehold(db, 'hA', (tx) =>
      tx
        .select()
        .from(schema.budgetAmount)
        .where(eq(schema.budgetAmount.budgetLineId, b.budgetLineId)),
    );
    expect(seenAmounts).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(schema.budgetAmount)
        .set({ amount: 1 })
        .where(eq(schema.budgetAmount.budgetLineId, b.budgetLineId))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withHousehold(db, 'hA', (tx) =>
      tx
        .delete(schema.budgetLineCategory)
        .where(eq(schema.budgetLineCategory.budgetLineId, b.budgetLineId))
        .returning(),
    );
    expect(deleted).toEqual([]);
    const own = await withHousehold(db, 'hB', (tx) =>
      tx
        .select()
        .from(schema.budgetAmount)
        .where(eq(schema.budgetAmount.budgetLineId, b.budgetLineId)),
    );
    expect(own).toHaveLength(1);
  });

  it('budget_line_category and budget_amount: WITH CHECK rejects a row claiming another household', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetAmount)
          .values({ householdId: 'hB', budgetLineId: b.budgetLineId, monthIndex: 2, amount: 1 }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
    const moved = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.budgetLineCategory)
          .set({ householdId: 'hB' })
          .where(eq(schema.budgetLineCategory.budgetLineId, a.budgetLineId)),
      ),
    );
    expect(moved).toMatch(/row-level security/i);
  });

  it('keeps updated_at triggers on budget, budget_line and recurring', async () => {
    const { rows } = await db.execute(
      sql`select event_object_table as t from information_schema.triggers
          where trigger_name in ('budget_set_updated_at', 'budget_line_set_updated_at',
                                 'recurring_set_updated_at')
          order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(['budget', 'budget_line', 'recurring']);
  });

  describe('composite FKs reject cross-household links', () => {
    it('budget_line to another household budget, group or account', async () => {
      const insertLine = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.budgetLine).values({
            householdId: 'hA',
            budgetId: a.budgetId,
            kind: 'income',
            name: `L-${Math.random()}`,
            position: 1,
            ...over,
          } as never),
        );
      expect(await pgError(insertLine({ budgetId: b.budgetId }))).toMatch(/foreign key/i);
      expect(await pgError(insertLine({ groupId: b.groupId }))).toMatch(/foreign key/i);
      expect(await pgError(insertLine({ accountId: b.accountId }))).toMatch(/foreign key/i);
    });

    it('budget_line_category to another household line or category', async () => {
      const [line] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hA',
            budgetId: a.budgetId,
            kind: 'expense',
            name: 'Fun',
            position: 2,
          })
          .returning(),
      );
      const link = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.budgetLineCategory).values({
            householdId: 'hA',
            budgetLineId: line!.id,
            budgetId: a.budgetId,
            categoryId: a.categoryId,
            ...over,
          } as never),
        );
      expect(await pgError(link({ categoryId: b.categoryId }))).toMatch(/foreign key/i);
      // Use a free category so the FK (not the per-budget unique) is what rejects the line.
      const [spare] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.category)
          .values({ householdId: 'hA', groupId: a.groupId, name: 'Spare' })
          .returning(),
      );
      expect(await pgError(link({ budgetLineId: b.budgetLineId, categoryId: spare!.id }))).toMatch(
        /foreign key/i,
      );
    });

    it('budget_line_category denormalised budget_id must match the line budget', async () => {
      const [other] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budget)
          .values({ householdId: 'hA', startMonth: '2027-01-01', name: '2027', createdBy: 'u1' })
          .returning(),
      );
      const [line] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hA',
            budgetId: a.budgetId,
            kind: 'expense',
            name: 'Mismatch',
            position: 3,
          })
          .returning(),
      );
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.budgetLineCategory).values({
            householdId: 'hA',
            budgetLineId: line!.id,
            budgetId: other!.id,
            categoryId: a.categoryId,
          }),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });

    describe('investment buckets', () => {
      const addBucket = (h: string, accountId: string, over: Record<string, unknown> = {}) =>
        withHousehold(db, h, (tx) =>
          tx
            .insert(schema.investmentBucket)
            .values({
              householdId: h,
              accountId,
              provider: 'trading212',
              externalId: `pie-${Math.random()}`,
              name: 'Pie',
              ...over,
            } as never)
            .returning(),
        );
      const linkBucket = (bucketId: string, over: Record<string, unknown> = {}) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.budgetLineBucket).values({
            householdId: 'hA',
            budgetLineId: a.budgetLineId,
            budgetId: a.budgetId,
            bucketId,
            ...over,
          } as never),
        );

      it('investment_bucket: unique (account_id, external_id) and household-pinned account FK', async () => {
        await addBucket('hA', a.accountId, { externalId: 'dup' });
        expect(await pgError(addBucket('hA', a.accountId, { externalId: 'dup' }))).toMatch(
          /duplicate key/i,
        );
        expect(await pgError(addBucket('hA', b.accountId))).toMatch(/foreign key/i);
      });

      it('budget_line_bucket: per-budget unique, line and bucket FKs pinned to the household', async () => {
        const [bucket] = await addBucket('hA', a.accountId);
        const [bBucket] = await addBucket('hB', b.accountId);
        await linkBucket(bucket!.id);
        expect(await pgError(linkBucket(bucket!.id))).toMatch(/duplicate key/i);
        // Same bucket on a second line of the same budget: per-budget unique rejects it.
        const [line2] = await withHousehold(db, 'hA', (tx) =>
          tx
            .insert(schema.budgetLine)
            .values({
              householdId: 'hA',
              budgetId: a.budgetId,
              kind: 'saving',
              name: 'Second',
              position: 5,
            })
            .returning(),
        );
        expect(await pgError(linkBucket(bucket!.id, { budgetLineId: line2!.id }))).toMatch(
          /budget_line_bucket_budget_bucket_unique/,
        );
        expect(await pgError(linkBucket(bBucket!.id))).toMatch(/foreign key/i);
        expect(await pgError(linkBucket(bucket!.id, { budgetLineId: b.budgetLineId }))).toMatch(
          /foreign key|duplicate key/i,
        );
      });

      it('investment_bucket_snapshot: primary key (bucket_id, as_of), pinned account and cascade', async () => {
        const [bucket] = await addBucket('hA', a.accountId);
        const snap = (over: Record<string, unknown> = {}) =>
          withHousehold(db, 'hA', (tx) =>
            tx.insert(schema.investmentBucketSnapshot).values({
              householdId: 'hA',
              accountId: a.accountId,
              bucketId: bucket!.id,
              asOf: '2026-10-30',
              investedMinor: 12345,
              valueMinor: null,
              currency: 'EUR',
              ...over,
            } as never),
          );
        await snap();
        expect(await pgError(snap())).toMatch(/duplicate key/i);
        expect(await pgError(snap({ asOf: '2026-10-31', accountId: b.accountId }))).toMatch(
          /foreign key/i,
        );
        await withHousehold(db, 'hA', (tx) =>
          tx.delete(schema.investmentBucket).where(eq(schema.investmentBucket.id, bucket!.id)),
        );
        const { rows } = await withHousehold(db, 'hA', (tx) =>
          tx.execute(
            sql`select count(*)::int as n from investment_bucket_snapshot where bucket_id = ${bucket!.id}`,
          ),
        );
        expect(rows[0]).toEqual({ n: 0 });
      });

      it('deleting an account cascades its buckets, snapshots and links', async () => {
        const [acct] = await withHousehold(db, 'hA', (tx) =>
          tx
            .insert(schema.financialAccount)
            .values({ householdId: 'hA', name: 'Broker', type: 'investment' })
            .returning(),
        );
        const [bucket] = await addBucket('hA', acct!.id);
        await withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.investmentBucketSnapshot).values({
            householdId: 'hA',
            accountId: acct!.id,
            bucketId: bucket!.id,
            asOf: '2026-10-30',
            investedMinor: 1,
            currency: 'EUR',
          }),
        );
        await linkBucket(bucket!.id);
        await withHousehold(db, 'hA', (tx) =>
          tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, acct!.id)),
        );
        const { rows } = await withHousehold(db, 'hA', (tx) =>
          tx.execute(
            sql`select (select count(*)::int from investment_bucket where id = ${bucket!.id}) as b,
                       (select count(*)::int from investment_bucket_snapshot where bucket_id = ${bucket!.id}) as s,
                       (select count(*)::int from budget_line_bucket where bucket_id = ${bucket!.id}) as l`,
          ),
        );
        expect(rows[0]).toEqual({ b: 0, s: 0, l: 0 });
      });
    });

    it('budget_amount to another household line', async () => {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx
            .insert(schema.budgetAmount)
            .values({ householdId: 'hA', budgetLineId: b.budgetLineId, monthIndex: 3, amount: 1 }),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });

    it('recurring to another household account, category or line', async () => {
      const insertRec = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.recurring).values({
            householdId: 'hA',
            merchantKey: `m-${Math.random()}`,
            name: 'x',
            amount: -1,
            currency: 'EUR',
            cadence: 'weekly',
            status: 'confirmed',
            source: 'declared',
            ...over,
          } as never),
        );
      expect(await pgError(insertRec({ accountId: b.accountId }))).toMatch(/foreign key/i);
      expect(await pgError(insertRec({ categoryId: b.categoryId }))).toMatch(/foreign key/i);
      expect(await pgError(insertRec({ budgetLineId: b.budgetLineId }))).toMatch(/foreign key/i);
    });

    it('household_settings.hub_account_id to another household account', async () => {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx
            .update(schema.householdSettings)
            .set({ hubAccountId: b.accountId })
            .where(eq(schema.householdSettings.householdId, 'hA')),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });
  });

  describe('uniqueness and checks', () => {
    it('one budget per household per start month, but other households may reuse it', async () => {
      const dup = withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budget)
          .values({ householdId: 'hA', startMonth: '2026-01-01', name: 'dup', createdBy: 'u1' }),
      );
      expect(await pgError(dup)).toMatch(/duplicate key/i);
    });

    it('rejects a budget start month that is not the first day or an unknown status', async () => {
      const mid = withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budget)
          .values({ householdId: 'hA', startMonth: '2028-01-15', name: 'x', createdBy: 'u1' }),
      );
      expect(await pgError(mid)).toMatch(/check constraint/i);
      const status = withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.budget).values({
          householdId: 'hA',
          startMonth: '2028-02-01',
          name: 'x',
          createdBy: 'u1',
          status: 'nope',
        } as never),
      );
      expect(await pgError(status)).toMatch(/check constraint/i);
    });

    it('budget_line: unique (budget, kind, name) and kind check', async () => {
      const dup = withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.budgetLine).values({
          householdId: 'hA',
          budgetId: a.budgetId,
          kind: 'expense',
          name: 'Housing',
          position: 9,
        }),
      );
      expect(await pgError(dup)).toMatch(/duplicate key/i);
      const kind = withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.budgetLine).values({
          householdId: 'hA',
          budgetId: a.budgetId,
          kind: 'transfer',
          name: 'x',
          position: 9,
        } as never),
      );
      expect(await pgError(kind)).toMatch(/check constraint/i);
    });

    it('a category is linked to at most one line per budget, but may be reused across budgets', async () => {
      const [line] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hA',
            budgetId: a.budgetId,
            kind: 'expense',
            name: 'Second',
            position: 4,
          })
          .returning(),
      );
      const dup = withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.budgetLineCategory).values({
          householdId: 'hA',
          budgetLineId: line!.id,
          budgetId: a.budgetId,
          categoryId: a.categoryId,
        }),
      );
      expect(await pgError(dup)).toMatch(/duplicate key/i);
      const [otherBudget] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budget)
          .values({ householdId: 'hA', startMonth: '2029-01-01', name: '2029', createdBy: 'u1' })
          .returning(),
      );
      const [otherLine] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hA',
            budgetId: otherBudget!.id,
            kind: 'expense',
            name: 'Housing',
            position: 0,
          })
          .returning(),
      );
      const ok = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.budgetLineCategory)
          .values({
            householdId: 'hA',
            budgetLineId: otherLine!.id,
            budgetId: otherBudget!.id,
            categoryId: a.categoryId,
          })
          .returning(),
      );
      expect(ok).toHaveLength(1);
    });

    it('budget_amount: one row per line and month, month 1..12, amount >= 0', async () => {
      const put = (monthIndex: number, amount: number) =>
        withHousehold(db, 'hA', (tx) =>
          tx
            .insert(schema.budgetAmount)
            .values({ householdId: 'hA', budgetLineId: a.budgetLineId, monthIndex, amount }),
        );
      expect(await pgError(put(1, 10))).toMatch(/duplicate key/i);
      expect(await pgError(put(0, 10))).toMatch(/check constraint/i);
      expect(await pgError(put(13, 10))).toMatch(/check constraint/i);
      expect(await pgError(put(2, -1))).toMatch(/check constraint/i);
      await put(12, 0);
    });

    it('recurring: signed amount, enum checks, unique key only for detected rows', async () => {
      const insertRec = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.recurring).values({
            householdId: 'hA',
            merchantKey: 'landlord',
            name: 'x',
            amount: 25000,
            currency: 'EUR',
            cadence: 'monthly',
            status: 'confirmed',
            source: 'declared',
            ...over,
          } as never),
        );
      // Positive (income) amounts are fine, and declared/import rows may repeat the key.
      await insertRec({});
      await insertRec({ source: 'import' });
      // Detected rows are unique per (household, merchant_key, cadence).
      expect(await pgError(insertRec({ source: 'detected' }))).toMatch(/duplicate key/i);
      // Another cadence or another household is fine.
      await insertRec({ source: 'detected', cadence: 'yearly' });
      await insertRec({ source: 'detected', merchantKey: 'only-in-a' });
      const inB = await withHousehold(db, 'hB', (tx) =>
        tx
          .insert(schema.recurring)
          .values({
            householdId: 'hB',
            merchantKey: 'only-in-a',
            name: 'x',
            amount: 1,
            currency: 'EUR',
            cadence: 'monthly',
            status: 'detected',
            source: 'detected',
          })
          .returning(),
      );
      expect(inB).toHaveLength(1);
      for (const bad of [{ cadence: 'daily' }, { status: 'nope' }, { source: 'nope' }]) {
        expect(await pgError(insertRec({ merchantKey: 'z', ...bad }))).toMatch(/check constraint/i);
      }
    });

    it('household_settings: alert thresholds default to 80/100 and must be between 1 and 200', async () => {
      const [row] = await withHousehold(db, 'hA', (tx) =>
        tx
          .select()
          .from(schema.householdSettings)
          .where(eq(schema.householdSettings.householdId, 'hA')),
      );
      expect(row).toMatchObject({ hubAccountId: null, budgetAlertThresholds: [80, 100] });
      const setThresholds = (budgetAlertThresholds: number[]) =>
        withHousehold(db, 'hA', (tx) =>
          tx
            .update(schema.householdSettings)
            .set({ budgetAlertThresholds })
            .where(eq(schema.householdSettings.householdId, 'hA')),
        );
      expect(await pgError(setThresholds([0, 100]))).toMatch(/check constraint/i);
      expect(await pgError(setThresholds([80, 201]))).toMatch(/check constraint/i);
      expect(await pgError(setThresholds([80, null as unknown as number]))).toMatch(
        /check constraint/i,
      );
      // An empty array is allowed and means "no budget alerts".
      await setThresholds([]);
      const [empty] = await withHousehold(db, 'hA', (tx) =>
        tx
          .select()
          .from(schema.householdSettings)
          .where(eq(schema.householdSettings.householdId, 'hA')),
      );
      expect(empty!.budgetAlertThresholds).toEqual([]);
      await setThresholds([50, 90, 200]);
      await setThresholds([80, 100]);
    });
  });

  describe('delete behaviour', () => {
    it('deleting a category removes its budget_line_category link and keeps the line', async () => {
      const s = await withHousehold(db, 'hB', async (tx) => {
        const [cat] = await tx
          .insert(schema.category)
          .values({ householdId: 'hB', groupId: b.groupId, name: 'Temp' })
          .returning();
        await tx.insert(schema.budgetLineCategory).values({
          householdId: 'hB',
          budgetLineId: b.budgetLineId,
          budgetId: b.budgetId,
          categoryId: cat!.id,
        });
        return cat!;
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.category).where(eq(schema.category.id, s.id)),
      );
      const links = await withHousehold(db, 'hB', (tx) =>
        tx
          .select()
          .from(schema.budgetLineCategory)
          .where(eq(schema.budgetLineCategory.categoryId, s.id)),
      );
      expect(links).toEqual([]);
      const lines = await withHousehold(db, 'hB', (tx) =>
        tx.select().from(schema.budgetLine).where(eq(schema.budgetLine.id, b.budgetLineId)),
      );
      expect(lines).toHaveLength(1);
    });

    it('deleting an account or a category group nulls the line reference only', async () => {
      const [grp, acc] = await withHousehold(db, 'hB', async (tx) => {
        const [g] = await tx
          .insert(schema.categoryGroup)
          .values({ householdId: 'hB', name: 'Tmp', kind: 'expense' })
          .returning();
        const [ac] = await tx
          .insert(schema.financialAccount)
          .values({ householdId: 'hB', name: 'Tmp', type: 'savings' })
          .returning();
        return [g!, ac!] as const;
      });
      const [line] = await withHousehold(db, 'hB', (tx) =>
        tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hB',
            budgetId: b.budgetId,
            kind: 'saving',
            name: 'Tmp',
            position: 5,
            groupId: grp.id,
            accountId: acc.id,
          })
          .returning(),
      );
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, acc.id)),
      );
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.categoryGroup).where(eq(schema.categoryGroup.id, grp.id)),
      );
      const [after] = await withHousehold(db, 'hB', (tx) =>
        tx.select().from(schema.budgetLine).where(eq(schema.budgetLine.id, line!.id)),
      );
      expect(after).toMatchObject({ accountId: null, groupId: null, householdId: 'hB' });
    });

    it('deleting the hub account nulls hub_account_id and keeps the household', async () => {
      const [acc] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.financialAccount)
          .values({ householdId: 'hA', name: 'Hub', type: 'checking' })
          .returning(),
      );
      await withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.householdSettings)
          .set({ hubAccountId: acc!.id })
          .where(eq(schema.householdSettings.householdId, 'hA')),
      );
      await withHousehold(db, 'hA', (tx) =>
        tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, acc!.id)),
      );
      const [row] = await withHousehold(db, 'hA', (tx) =>
        tx
          .select()
          .from(schema.householdSettings)
          .where(eq(schema.householdSettings.householdId, 'hA')),
      );
      expect(row).toMatchObject({ householdId: 'hA', hubAccountId: null });
    });

    it('deleting an account, category or line nulls the recurring reference and keeps the row', async () => {
      const make = async (name: string) =>
        withHousehold(db, 'hB', async (tx) => {
          const [grp] = await tx
            .insert(schema.categoryGroup)
            .values({ householdId: 'hB', name, kind: 'expense' })
            .returning();
          const [cat] = await tx
            .insert(schema.category)
            .values({ householdId: 'hB', groupId: grp!.id, name })
            .returning();
          const [acc] = await tx
            .insert(schema.financialAccount)
            .values({ householdId: 'hB', name, type: 'checking' })
            .returning();
          const [line] = await tx
            .insert(schema.budgetLine)
            .values({ householdId: 'hB', budgetId: b.budgetId, kind: 'expense', name, position: 7 })
            .returning();
          const [rec] = await tx
            .insert(schema.recurring)
            .values({
              householdId: 'hB',
              merchantKey: `del-${name}`,
              name,
              amount: -1,
              currency: 'EUR',
              cadence: 'monthly',
              status: 'confirmed',
              source: 'declared',
              accountId: acc!.id,
              categoryId: cat!.id,
              budgetLineId: line!.id,
            })
            .returning();
          return { cat: cat!, acc: acc!, line: line!, rec: rec! };
        });
      const readRec = (id: string) =>
        withHousehold(db, 'hB', async (tx) => {
          const [r] = await tx.select().from(schema.recurring).where(eq(schema.recurring.id, id));
          return r;
        });
      const x = await make('rdel');
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, x.acc.id)),
      );
      expect(await readRec(x.rec.id)).toMatchObject({
        householdId: 'hB',
        accountId: null,
        categoryId: x.cat.id,
        budgetLineId: x.line.id,
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.category).where(eq(schema.category.id, x.cat.id)),
      );
      expect(await readRec(x.rec.id)).toMatchObject({
        householdId: 'hB',
        categoryId: null,
        budgetLineId: x.line.id,
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.budgetLine).where(eq(schema.budgetLine.id, x.line.id)),
      );
      expect(await readRec(x.rec.id)).toMatchObject({ householdId: 'hB', budgetLineId: null });
    });

    it('deleting a budget cascades its lines, links and amounts', async () => {
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.budget).where(eq(schema.budget.id, b.budgetId)),
      );
      const { rows } = await withHousehold(db, 'hB', (tx) =>
        tx.execute(
          sql`select (select count(*)::int from budget_line) as l,
                     (select count(*)::int from budget_line_category) as c,
                     (select count(*)::int from budget_amount) as a`,
        ),
      );
      expect(rows[0]).toEqual({ l: 0, c: 0, a: 0 });
    });
  });
});
