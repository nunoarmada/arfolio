import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '../src/index.js';
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

describe('household tenant isolation (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    // household_settings.household_id references the Better Auth organisation table.
    await db
      .insert(schema.organization)
      .values(['h1', 'h2'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    await withHousehold(db, 'h1', (tx) =>
      tx.insert(schema.householdSettings).values({ householdId: 'h1' }),
    );
    await withHousehold(db, 'h2', (tx) =>
      tx.insert(schema.householdSettings).values({ householdId: 'h2' }),
    );
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('returns only the current household rows inside withHousehold', async () => {
    const rows = await withHousehold(db, 'h1', (tx) => tx.select().from(schema.householdSettings));
    expect(rows.map((r) => r.householdId)).toEqual(['h1']);
  });

  it('applies column defaults', async () => {
    const [row] = await withHousehold(db, 'h1', (tx) => tx.select().from(schema.householdSettings));
    expect(row).toMatchObject({
      currency: 'EUR',
      locale: 'en',
      timezone: 'UTC',
      fiscalYearStartMonth: 1,
      emergencyFundMonths: 6,
      aiEnabled: false,
    });
  });

  it('returns no rows outside withHousehold', async () => {
    const rows = await db.select().from(schema.householdSettings);
    expect(rows).toEqual([]);
  });

  it('rejects inserting a row for another household (WITH CHECK)', async () => {
    const message = await pgError(
      withHousehold(db, 'h1', (tx) =>
        tx.insert(schema.householdSettings).values({ householdId: 'h3' }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('rejects updating a row to another household (WITH CHECK)', async () => {
    const message = await pgError(
      withHousehold(db, 'h1', (tx) =>
        tx.update(schema.householdSettings).set({ householdId: 'h3' }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('does not leak the household id to later transactions on the pool', async () => {
    await withHousehold(db, 'h1', async () => undefined);
    const rows = await db.select().from(schema.householdSettings);
    expect(rows).toEqual([]);
  });

  it('rejects an empty household id', async () => {
    await expect(withHousehold(db, '', async () => undefined)).rejects.toThrow(/household/i);
  });

  it('enforces fiscal_year_start_month between 1 and 12', async () => {
    const message = await pgError(
      withHousehold(db, 'h1', (tx) =>
        tx.update(schema.householdSettings).set({ fiscalYearStartMonth: 13 }),
      ),
    );
    expect(message).toMatch(/check constraint/i);
  });
});
