import { eq, sql } from 'drizzle-orm';
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

describe('undo_token (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  const ids: Record<string, string> = {};

  const insert = (tx: Parameters<Parameters<typeof withHousehold>[2]>[0], h: string) =>
    tx
      .insert(schema.undoToken)
      .values({
        householdId: h,
        userId: 'u',
        kind: 'categorisation',
        payload: {},
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: schema.undoToken.id });

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    for (const h of ['hA', 'hB']) {
      ids[h] = (await withHousehold(db, h, (tx) => insert(tx, h)))[0]!.id;
    }
  });
  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('has RLS enabled with the household_isolation policy', async () => {
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, (select count(*)::int from pg_policies p
          where p.tablename = c.relname and p.policyname = 'household_isolation') as policies
          from pg_class c where c.relname = 'undo_token' and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]).toMatchObject({ rls: true, policies: 1 });
  });

  it('hides, protects and refuses cross-household tokens', async () => {
    const seen = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.undoToken).where(eq(schema.undoToken.id, ids.hB!)),
    );
    expect(seen).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(schema.undoToken)
        .set({ usedAt: new Date() })
        .where(eq(schema.undoToken.id, ids.hB!))
        .returning(),
    );
    expect(updated).toEqual([]);
    const message = await pgError(withHousehold(db, 'hA', (tx) => insert(tx, 'hB')));
    expect(message).toMatch(/row-level security/i);
    const outside = await db.select().from(schema.undoToken);
    expect(outside).toEqual([]);
  });
});
