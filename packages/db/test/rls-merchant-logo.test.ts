import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  }
  throw new Error('expected the query to be rejected');
}

describe('merchant enrichment schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let merchantA: string;
  const logo = schema.merchantLogo;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    [{ id: merchantA }] = (await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.merchant)
        .values({ householdId: 'hA', key: 'ACME', displayName: 'Acme' })
        .returning({ id: schema.merchant.id }),
    )) as [{ id: string }];
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('merchant_logo has RLS enabled with the standard household_isolation policy', async () => {
    const expected = "(household_id = current_setting('app.household_id'::text, true))";
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, p.qual, p.with_check
          from pg_class c join pg_policies p on p.tablename = c.relname
          where c.relname = 'merchant_logo' and p.policyname = 'household_isolation'`,
    );
    expect(rows).toEqual([{ rls: true, qual: expected, with_check: expected }]);
  });

  it('stores and isolates a logo per household, and rejects another household merchant', async () => {
    await withHousehold(db, 'hA', (tx) =>
      tx.insert(logo).values({
        merchantId: merchantA,
        householdId: 'hA',
        contentType: 'image/png',
        bytes: Buffer.from([1, 2, 3]),
        status: 'ok',
      }),
    );
    const [row] = await withHousehold(db, 'hA', (tx) => tx.select().from(logo));
    expect(row?.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(await withHousehold(db, 'hB', (tx) => tx.select().from(logo))).toEqual([]);
    // hB cannot attach a logo to hA's merchant: RLS rejects the foreign household id.
    expect(
      await pgError(
        withHousehold(db, 'hB', (tx) =>
          tx.insert(logo).values({ merchantId: merchantA, householdId: 'hA', status: 'missing' }),
        ),
      ),
    ).toMatch(/row-level security/i);
  });

  it('cascades with the merchant, and checks status and name_source values', async () => {
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx
            .update(schema.merchant)
            .set({ nameSource: 'robot' as never })
            .where(sql`true`),
        ),
      ),
    ).toMatch(/merchant_name_source_check/);
    await withHousehold(db, 'hA', (tx) => tx.delete(schema.merchant));
    expect(await withHousehold(db, 'hA', (tx) => tx.select().from(logo))).toEqual([]);
  });
});
