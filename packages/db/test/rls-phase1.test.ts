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

const TABLES = [
  'financial_account',
  'category_group',
  'category',
  'merchant',
  'rule',
  'import_batch',
  'import_preset',
  'transaction',
] as const;

interface Seed {
  groupId: string;
  categoryId: string;
  accountId: string;
  merchantId: string;
  ruleId: string;
  batchId: string;
  presetId: string;
  txId: string;
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
  const [merchant] = await tx
    .insert(schema.merchant)
    .values({ householdId: h, key: 'shop', displayName: 'Shop', defaultCategoryId: category!.id })
    .returning();
  const [rule] = await tx
    .insert(schema.rule)
    .values({
      householdId: h,
      name: 'Rent rule',
      priority: 1,
      condition: { descriptionContains: 'rent' },
      categoryId: category!.id,
      createdBy: 'u1',
    })
    .returning();
  const [batch] = await tx
    .insert(schema.importBatch)
    .values({
      householdId: h,
      accountId: account!.id,
      source: 'csv',
      filename: 'a.csv',
      createdBy: 'u1',
    })
    .returning();
  const [preset] = await tx
    .insert(schema.importPreset)
    .values({ householdId: h, name: 'Bank', kind: 'csv', mapping: { date: 0 }, createdBy: 'u1' })
    .returning();
  const [txn] = await tx
    .insert(schema.transaction)
    .values({
      householdId: h,
      accountId: account!.id,
      dedupeHash: 'hash-1',
      bookingDate: '2026-01-02',
      amount: -1250,
      currency: 'EUR',
      status: 'booked',
      rawDescription: 'RENT',
      categoryId: category!.id,
      merchantId: merchant!.id,
      importBatchId: batch!.id,
      source: 'import',
    })
    .returning();
  return {
    groupId: group!.id,
    categoryId: category!.id,
    accountId: account!.id,
    merchantId: merchant!.id,
    ruleId: rule!.id,
    batchId: batch!.id,
    presetId: preset!.id,
    txId: txn!.id,
  };
}

describe('phase 1 schema (as pfm_app)', () => {
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
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  const tableObjects = () =>
    ({
      financial_account: [schema.financialAccount, 'accountId'],
      category_group: [schema.categoryGroup, 'groupId'],
      category: [schema.category, 'categoryId'],
      merchant: [schema.merchant, 'merchantId'],
      rule: [schema.rule, 'ruleId'],
      import_batch: [schema.importBatch, 'batchId'],
      import_preset: [schema.importPreset, 'presetId'],
      transaction: [schema.transaction, 'txId'],
    }) as const;

  it.each(TABLES)('%s has RLS enabled with a household_isolation policy', async (table) => {
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, (select count(*)::int from pg_policies p
          where p.tablename = c.relname and p.policyname = 'household_isolation') as policies
          from pg_class c where c.relname = ${table} and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]).toMatchObject({ rls: true, policies: 1 });
  });

  it.each(TABLES)('%s: policy USING and WITH CHECK use the household setting', async (table) => {
    const expected = "(household_id = current_setting('app.household_id'::text, true))";
    const { rows } = await db.execute(
      sql`select qual, with_check from pg_policies
          where tablename = ${table} and policyname = 'household_isolation'`,
    );
    expect(rows).toEqual([{ qual: expected, with_check: expected }]);
  });

  it.each(TABLES)('%s: moving an own row to another household is rejected', async (table) => {
    const [tbl, key] = tableObjects()[table];
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

  it.each(TABLES)('%s: household A cannot see, update or delete B rows', async (table) => {
    const [tbl, key] = tableObjects()[table];
    const t = tbl as unknown as PgTable;
    const idCol = (tbl as unknown as { id: PgColumn }).id;
    const bId = b[key];
    const seen = await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(idCol, bId)));
    expect(seen).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(t)
        .set({ updatedAt: new Date() } as never)
        .where(eq(idCol, bId))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withHousehold(db, 'hA', (tx) =>
      tx.delete(t).where(eq(idCol, bId)).returning(),
    );
    expect(deleted).toEqual([]);
    const own = await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(idCol, bId)));
    expect(own).toHaveLength(1);
  });

  it.each(TABLES)('%s: no rows visible outside withHousehold', async (table) => {
    const [t] = tableObjects()[table];
    expect(await db.select().from(t as unknown as PgTable)).toEqual([]);
  });

  it('rejects inserting a row for another household (WITH CHECK)', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.categoryGroup).values({ householdId: 'hB', name: 'X', kind: 'income' }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('rejects a transaction in A pointing at B account (composite FK)', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.transaction).values({
          householdId: 'hA',
          accountId: b.accountId,
          dedupeHash: 'x',
          bookingDate: '2026-01-02',
          amount: 1,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'x',
          source: 'manual',
        }),
      ),
    );
    expect(message).toMatch(/foreign key/i);
  });

  it('rejects a transaction in A pointing at B category (composite FK)', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.transaction)
          .set({ categoryId: b.categoryId })
          .where(eq(schema.transaction.id, a.txId)),
      ),
    );
    expect(message).toMatch(/foreign key/i);
  });

  it('rejects rule, category and import_batch references across households', async () => {
    const rule = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.rule).values({
          householdId: 'hA',
          name: 'r',
          priority: 1,
          condition: {},
          categoryId: b.categoryId,
          createdBy: 'u',
        }),
      ),
    );
    const cat = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.category).values({ householdId: 'hA', groupId: b.groupId, name: 'c' }),
      ),
    );
    const batch = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.importBatch).values({
          householdId: 'hA',
          accountId: b.accountId,
          source: 'csv',
          filename: 'f',
          createdBy: 'u',
        }),
      ),
    );
    for (const m of [rule, cat, batch]) expect(m).toMatch(/foreign key/i);
  });

  it('rejects a transaction in A pointing at B import batch (composite FK)', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.transaction)
          .set({ importBatchId: b.batchId })
          .where(eq(schema.transaction.id, a.txId)),
      ),
    );
    expect(message).toMatch(/foreign key/i);
  });

  it('skips the composite FK check when the nullable reference is null (MATCH SIMPLE)', async () => {
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.transaction)
        .values({
          householdId: 'hA',
          accountId: a.accountId,
          dedupeHash: 'null-refs',
          bookingDate: '2026-01-03',
          amount: 5,
          currency: 'EUR',
          status: 'pending',
          rawDescription: 'n',
          source: 'manual',
        })
        .returning(),
    );
    expect(row).toMatchObject({
      categoryId: null,
      merchantId: null,
      importBatchId: null,
      needsReview: false,
      categorisedBy: null,
    });
  });

  it('keeps amounts as integers with defaults on account', async () => {
    const [acc] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.financialAccount).where(eq(schema.financialAccount.id, a.accountId)),
    );
    expect(acc).toMatchObject({
      currency: 'EUR',
      openingBalance: 0,
      includeInBudget: true,
      includeInNetWorth: true,
      sort: 0,
      archivedAt: null,
    });
    const [txn] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.transaction).where(eq(schema.transaction.id, a.txId)),
    );
    expect(txn!.amount).toBe(-1250);
  });

  it('maintains updated_at on update', async () => {
    const before = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.merchant).where(eq(schema.merchant.id, a.merchantId)),
    );
    await new Promise((r) => setTimeout(r, 20));
    const [after] = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(schema.merchant)
        .set({ displayName: 'Renamed' })
        .where(eq(schema.merchant.id, a.merchantId))
        .returning(),
    );
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before[0]!.updatedAt.getTime());
    expect(after!.createdAt.getTime()).toBe(before[0]!.createdAt.getTime());
  });

  it('enforces unique (account_id, dedupe_hash)', async () => {
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.transaction).values({
          householdId: 'hA',
          accountId: a.accountId,
          dedupeHash: 'hash-1',
          bookingDate: '2026-01-02',
          amount: 1,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'dup',
          source: 'manual',
        }),
      ),
    );
    expect(message).toMatch(/duplicate key/i);
  });

  it('enforces unique (account_id, external_id) only when external_id is set', async () => {
    const base = {
      householdId: 'hA',
      accountId: a.accountId,
      bookingDate: '2026-01-02',
      amount: 1,
      currency: 'EUR',
      status: 'booked' as const,
      rawDescription: 'e',
      source: 'connector' as const,
    };
    await withHousehold(db, 'hA', async (tx) => {
      await tx.insert(schema.transaction).values({ ...base, dedupeHash: 'n1' });
      await tx.insert(schema.transaction).values({ ...base, dedupeHash: 'n2' });
      await tx.insert(schema.transaction).values({ ...base, dedupeHash: 'e1', externalId: 'ext' });
    });
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.transaction).values({ ...base, dedupeHash: 'e2', externalId: 'ext' }),
      ),
    );
    expect(message).toMatch(/duplicate key/i);
  });

  it('enforces merchant key and import preset name unique per household, not globally', async () => {
    const m = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.merchant).values({ householdId: 'hA', key: 'shop', displayName: 'Dup' }),
      ),
    );
    expect(m).toMatch(/duplicate key/i);
    const p = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.importPreset)
          .values({ householdId: 'hA', name: 'Bank', kind: 'xlsx', mapping: {}, createdBy: 'u' }),
      ),
    );
    expect(p).toMatch(/duplicate key/i);
  });

  it('rejects values outside the enum checks', async () => {
    const badAccount = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.financialAccount)
          .values({ householdId: 'hA', name: 'Z', type: 'bogus' as never }),
      ),
    );
    const badStatus = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.transaction)
          .set({ status: 'bogus' as never })
          .where(eq(schema.transaction.id, a.txId)),
      ),
    );
    const badKind = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.categoryGroup)
          .values({ householdId: 'hA', name: 'Z', kind: 'bogus' as never }),
      ),
    );
    for (const m of [badAccount, badStatus, badKind]) expect(m).toMatch(/check constraint/i);
  });

  it('cascades account deletion to its transactions and import batches', async () => {
    const acc = await withHousehold(db, 'hA', async (tx) => {
      const [x] = await tx
        .insert(schema.financialAccount)
        .values({ householdId: 'hA', name: 'Temp', type: 'cash' })
        .returning();
      await tx.insert(schema.transaction).values({
        householdId: 'hA',
        accountId: x!.id,
        dedupeHash: 'tmp',
        bookingDate: '2026-01-02',
        amount: 1,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 't',
        source: 'manual',
      });
      await tx.insert(schema.importBatch).values({
        householdId: 'hA',
        accountId: x!.id,
        source: 'csv',
        filename: 'tmp.csv',
        createdBy: 'u1',
      });
      await tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, x!.id));
      return {
        txns: await tx
          .select()
          .from(schema.transaction)
          .where(eq(schema.transaction.accountId, x!.id)),
        batches: await tx
          .select()
          .from(schema.importBatch)
          .where(eq(schema.importBatch.accountId, x!.id)),
      };
    });
    expect(acc).toEqual({ txns: [], batches: [] });
  });

  it('has the listed transaction indexes', async () => {
    const { rows } = await db.execute(
      sql`select indexname from pg_indexes where tablename = 'transaction'`,
    );
    const names = rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'transaction_household_booking_date_idx',
        'transaction_household_needs_review_idx',
        'transaction_household_category_idx',
        'transaction_household_import_batch_idx',
        'transaction_household_transfer_group_idx',
        'transaction_household_merchant_idx',
      ]),
    );
  });
});
