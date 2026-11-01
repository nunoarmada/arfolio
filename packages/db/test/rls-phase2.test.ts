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
  'connection',
  'connection_account',
  'consent_state',
  'sync_run',
  'balance_snapshot',
  'position_snapshot',
  'notification',
] as const;

interface Seed {
  accountId: string;
  categoryId: string;
  connectionId: string;
  connectionAccountId: string;
  consentStateId: string;
  syncRunId: string;
  balanceSnapshotId: string;
  positionSnapshotId: string;
  notificationId: string;
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
  const [connection] = await tx
    .insert(schema.connection)
    .values({
      householdId: h,
      provider: 'enablebanking',
      displayName: 'Bank',
      status: 'active',
      createdBy: 'u1',
    })
    .returning();
  const [connectionAccount] = await tx
    .insert(schema.connectionAccount)
    .values({
      householdId: h,
      connectionId: connection!.id,
      accountId: account!.id,
      externalUid: 'uid-1',
      externalKey: 'key-1',
      currency: 'EUR',
      name: 'Main',
    })
    .returning();
  const [consent] = await tx
    .insert(schema.consentState)
    .values({
      householdId: h,
      stateHash: `hash-${h}`,
      userId: 'u1',
      aspspName: 'Bank',
      aspspCountry: 'PT',
      expiresAt: new Date(Date.now() + 900_000),
    })
    .returning();
  const [run] = await tx
    .insert(schema.syncRun)
    .values({ householdId: h, connectionId: connection!.id, trigger: 'manual', status: 'running' })
    .returning();
  const [balance] = await tx
    .insert(schema.balanceSnapshot)
    .values({
      householdId: h,
      accountId: account!.id,
      asOf: '2026-01-02',
      balance: 12345,
      currency: 'EUR',
      source: 'enablebanking',
    })
    .returning();
  const [position] = await tx
    .insert(schema.positionSnapshot)
    .values({
      householdId: h,
      accountId: account!.id,
      asOf: '2026-01-02',
      instrument: 'IE00B4L5Y983',
      name: 'World ETF',
      quantity: '1.2345678901',
      priceMinor: 8000,
      valueMinor: 9876,
      currency: 'EUR',
    })
    .returning();
  const [notification] = await tx
    .insert(schema.notification)
    .values({ householdId: h, kind: 'consent_expiring', payload: { n: 1 }, dedupeKey: 'k1' })
    .returning();
  return {
    accountId: account!.id,
    categoryId: category!.id,
    connectionId: connection!.id,
    connectionAccountId: connectionAccount!.id,
    consentStateId: consent!.id,
    syncRunId: run!.id,
    balanceSnapshotId: balance!.id,
    positionSnapshotId: position!.id,
    notificationId: notification!.id,
  };
}

describe('phase 2 schema (as pfm_app)', () => {
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
      connection: [schema.connection, 'connectionId', { displayName: 'x' }],
      connection_account: [schema.connectionAccount, 'connectionAccountId', { name: 'x' }],
      consent_state: [schema.consentState, 'consentStateId', { usedAt: new Date() }],
      sync_run: [schema.syncRun, 'syncRunId', { finishedAt: new Date() }],
      balance_snapshot: [schema.balanceSnapshot, 'balanceSnapshotId', { source: 'x' }],
      position_snapshot: [schema.positionSnapshot, 'positionSnapshotId', { name: 'x' }],
      notification: [schema.notification, 'notificationId', { kind: 'sync_failing' }],
    }) as const;

  // FORCE ROW LEVEL SECURITY is intentionally not used (repo convention, see 0001): the owner
  // role runs migrations and maintenance; pfm_app is not the owner, so the policy applies to it.
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
    const [tbl, key, patch] = tableObjects()[table];
    const t = tbl as unknown as PgTable;
    const idCol = (tbl as unknown as { id: PgColumn }).id;
    const bId = b[key];
    const seen = await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(idCol, bId)));
    expect(seen).toEqual([]);
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
    const own = await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(idCol, bId)));
    expect(own).toHaveLength(1);
  });

  it.each(TABLES)('%s: no rows visible outside withHousehold', async (table) => {
    const [tbl] = tableObjects()[table];
    expect(await db.select().from(tbl as unknown as PgTable)).toEqual([]);
  });

  it('keeps the household and updated_at trigger on connection and connection_account', async () => {
    const { rows } = await db.execute(
      sql`select event_object_table as t from information_schema.triggers
          where trigger_name in ('connection_set_updated_at', 'connection_account_set_updated_at')
          order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(['connection', 'connection_account']);
  });

  it('defaults connection counters and rejects unknown provider or status', async () => {
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.connection).where(eq(schema.connection.id, a.connectionId)),
    );
    expect(row).toMatchObject({ consecutiveFailures: 0, manualRefreshesToday: 0 });
    for (const bad of [{ provider: 'nope' }, { status: 'nope' }]) {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.connection).values({
            householdId: 'hA',
            provider: 'trading212',
            displayName: 'x',
            status: 'pending',
            createdBy: 'u1',
            ...bad,
          } as never),
        ),
      );
      expect(message).toMatch(/check constraint/i);
    }
  });

  it('stores position quantity as an exact string', async () => {
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx
        .select({ q: schema.positionSnapshot.quantity })
        .from(schema.positionSnapshot)
        .where(eq(schema.positionSnapshot.id, a.positionSnapshotId)),
    );
    expect(row!.q).toBe('1.2345678901');
  });

  it('refuses a composite FK to another household (account, connection, AI category)', async () => {
    const [spare] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.financialAccount)
        .values({ householdId: 'hA', name: 'Spare', type: 'savings' })
        .returning(),
    );
    const link = (accountId: string, connectionId: string) =>
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.connectionAccount).values({
          householdId: 'hA',
          connectionId,
          accountId,
          externalUid: 'u2',
          externalKey: 'k2',
          currency: 'EUR',
          name: 'x',
        }),
      );
    expect(await pgError(link(b.accountId, a.connectionId))).toMatch(/foreign key/i);
    expect(await pgError(link(spare!.id, b.connectionId))).toMatch(/foreign key/i);
    const message = await pgError(
      withHousehold(db, 'hA', async (tx) => {
        const [t] = await tx
          .insert(schema.transaction)
          .values({
            householdId: 'hA',
            accountId: a.accountId,
            dedupeHash: 'h-ai',
            bookingDate: '2026-01-02',
            amount: -100,
            currency: 'EUR',
            status: 'booked',
            rawDescription: 'X',
            source: 'connector',
            aiSuggestedCategoryId: b.categoryId,
            aiConfidence: 0.8,
          })
          .returning();
        return t;
      }),
    );
    expect(message).toMatch(/foreign key/i);
  });

  it('enforces the uniqueness rules', async () => {
    const dupAccount = withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.connectionAccount).values({
        householdId: 'hA',
        connectionId: a.connectionId,
        accountId: a.accountId,
        externalUid: 'u3',
        externalKey: 'k3',
        currency: 'EUR',
        name: 'x',
      }),
    );
    expect(await pgError(dupAccount)).toMatch(/duplicate key/i);
    const dupState = withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.consentState).values({
        householdId: 'hA',
        stateHash: 'hash-hA',
        userId: 'u1',
        aspspName: 'Bank',
        aspspCountry: 'PT',
        expiresAt: new Date(),
      }),
    );
    expect(await pgError(dupState)).toMatch(/duplicate key/i);
    const dupBalance = withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.balanceSnapshot).values({
        householdId: 'hA',
        accountId: a.accountId,
        asOf: '2026-01-02',
        balance: 1,
        currency: 'EUR',
        source: 'enablebanking',
      }),
    );
    expect(await pgError(dupBalance)).toMatch(/duplicate key/i);
    const dupNotification = withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.notification)
        .values({ householdId: 'hA', kind: 'consent_expiring', payload: {}, dedupeKey: 'k1' }),
    );
    expect(await pgError(dupNotification)).toMatch(/duplicate key/i);
  });

  it('allows many notifications without a dedupe key, and the same key in another household', async () => {
    await withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.notification).values([
        { householdId: 'hA', kind: 'sync_failed', payload: {} },
        { householdId: 'hA', kind: 'sync_failed', payload: {} },
      ]),
    );
    const insertShared = (h: string) =>
      withHousehold(db, h, (tx) =>
        tx
          .insert(schema.notification)
          .values({ householdId: h, kind: 'consent_expiring', payload: {}, dedupeKey: 'shared' })
          .returning({ id: schema.notification.id }),
      );
    expect(await insertShared('hA')).toHaveLength(1);
    const inserted = await insertShared('hB');
    expect(inserted).toHaveLength(1);
  });

  it('cascades children when a connection or account is deleted', async () => {
    const counts = async () =>
      withHousehold(db, 'hB', async (tx) => {
        const { rows } = await tx.execute(
          sql`select (select count(*)::int from connection_account) as ca,
                     (select count(*)::int from sync_run) as sr`,
        );
        return rows[0];
      });
    expect(await counts()).toEqual({ ca: 1, sr: 1 });
    await withHousehold(db, 'hB', (tx) =>
      tx.delete(schema.connection).where(eq(schema.connection.id, b.connectionId)),
    );
    expect(await counts()).toEqual({ ca: 0, sr: 0 });
  });
  describe('notification_read', () => {
    const insertRead = (h: string, notificationId: string, userId = 'u1', rowHousehold = h) =>
      withHousehold(db, h, (tx) =>
        tx
          .insert(schema.notificationRead)
          .values({ notificationId, userId, householdId: rowHousehold })
          .returning(),
      );

    it('has RLS enabled with a household_isolation policy using the household setting', async () => {
      const expected = "(household_id = current_setting('app.household_id'::text, true))";
      const { rows } = await db.execute(
        sql`select c.relrowsecurity as rls, p.qual, p.with_check from pg_class c
            join pg_policies p on p.tablename = c.relname and p.policyname = 'household_isolation'
            where c.relname = 'notification_read' and c.relnamespace = 'public'::regnamespace`,
      );
      expect(rows).toEqual([{ rls: true, qual: expected, with_check: expected }]);
    });

    it('is one row per notification and user, and a household cannot see or write another one', async () => {
      expect(await insertRead('hA', a.notificationId)).toHaveLength(1);
      expect(await pgError(insertRead('hA', a.notificationId))).toMatch(/duplicate key/i);
      expect(await insertRead('hA', a.notificationId, 'u2')).toHaveLength(1);

      const seenByB = await withHousehold(db, 'hB', (tx) =>
        tx.select().from(schema.notificationRead),
      );
      expect(seenByB).toEqual([]);
      expect(await db.select().from(schema.notificationRead)).toEqual([]);
      // WITH CHECK: a row claiming another household is rejected.
      expect(await pgError(insertRead('hA', a.notificationId, 'u3', 'hB'))).toMatch(
        /row-level security/i,
      );
    });

    it('rejects a read pointing at another household notification (composite FK)', async () => {
      expect(await pgError(insertRead('hA', b.notificationId, 'u9'))).toMatch(
        /foreign key|violates/i,
      );
    });

    it('is removed with its notification', async () => {
      const [n] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.notification)
          .values({ householdId: 'hA', kind: 'sync_failing', payload: {} })
          .returning(),
      );
      await insertRead('hA', n!.id);
      await withHousehold(db, 'hA', (tx) =>
        tx.delete(schema.notification).where(eq(schema.notification.id, n!.id)),
      );
      const left = await withHousehold(db, 'hA', (tx) =>
        tx
          .select()
          .from(schema.notificationRead)
          .where(eq(schema.notificationRead.notificationId, n!.id)),
      );
      expect(left).toEqual([]);
    });
  });
});
