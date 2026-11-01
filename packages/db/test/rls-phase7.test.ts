import { eq, sql } from 'drizzle-orm';
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

const report = (householdId: string, month = '2026-09-01') => ({
  householdId,
  month,
  status: 'pending' as const,
  locale: 'en',
});

describe('phase 7 schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let reportA: string;
  const r = schema.aiReport;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    [{ id: reportA }] = (await withHousehold(db, 'hA', (tx) =>
      tx.insert(r).values(report('hA')).returning({ id: r.id }),
    )) as [{ id: string }];
    await withHousehold(db, 'hB', (tx) => tx.insert(r).values(report('hB')));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('ai_report has RLS enabled with the standard household_isolation policy', async () => {
    const expected = "(household_id = current_setting('app.household_id'::text, true))";
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, c.relforcerowsecurity as forced, p.qual, p.with_check
          from pg_class c join pg_policies p on p.tablename = c.relname
          where c.relname = 'ai_report' and p.policyname = 'household_isolation'`,
    );
    expect(rows).toEqual([{ rls: true, forced: false, qual: expected, with_check: expected }]);
  });

  it('isolates rows by household and WITH CHECK rejects a foreign row', async () => {
    expect(await withHousehold(db, 'hB', (tx) => tx.select().from(r))).toHaveLength(1);
    expect(await db.select().from(r)).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) =>
        tx.update(r).set({ status: 'failed' }).where(eq(r.id, reportA)).returning(),
      ),
    ).toEqual([]);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) => tx.insert(r).values(report('hB', '2026-08-01'))),
      ),
    ).toMatch(/row-level security/i);
  });

  it('one report per household and month, a first-of-month date and a known status', async () => {
    expect(
      await pgError(withHousehold(db, 'hA', (tx) => tx.insert(r).values(report('hA')))),
    ).toMatch(/ai_report_household_month_unique/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) => tx.insert(r).values(report('hA', '2026-08-15'))),
      ),
    ).toMatch(/ai_report_month_check/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx
            .insert(r)
            .values({ ...report('hA', '2026-07-01'), status: 'done' as unknown as 'ready' }),
        ),
      ),
    ).toMatch(/ai_report_status_check/);
  });

  it('defaults attempts and regenerations to 0 and nulls the requester with the user', async () => {
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(r).where(eq(r.id, reportA)),
    );
    expect(row).toMatchObject({ attempts: 0, regenerations: 0, requestedBy: null, facts: null });
  });
});
