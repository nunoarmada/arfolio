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

const sub = (householdId: string, userId: string, endpoint: string) => ({
  householdId,
  userId,
  endpoint,
  p256dh: 'p',
  auth: 'a',
});

describe('phase 5 schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    await db
      .insert(schema.user)
      .values(['u1', 'u2'].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    [{ id: aId }] = (await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.pushSubscription)
        .values(sub('hA', 'u1', 'https://push.example/a'))
        .returning({ id: schema.pushSubscription.id }),
    )) as [{ id: string }];
    [{ id: bId }] = (await withHousehold(db, 'hB', (tx) =>
      tx
        .insert(schema.pushSubscription)
        .values(sub('hB', 'u2', 'https://push.example/b'))
        .returning({ id: schema.pushSubscription.id }),
    )) as [{ id: string }];
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('push_subscription has RLS enabled with the standard household_isolation policy', async () => {
    const expected = "(household_id = current_setting('app.household_id'::text, true))";
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, p.qual, p.with_check
          from pg_class c join pg_policies p on p.tablename = c.relname
          where c.relname = 'push_subscription' and p.policyname = 'household_isolation'`,
    );
    expect(rows).toEqual([{ rls: true, qual: expected, with_check: expected }]);
  });

  it('push_subscription: no rows visible outside withHousehold', async () => {
    const { rows } = await db.execute(sql`select count(*)::int as n from push_subscription`);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('push_subscription: A cannot see, update or delete B rows', async () => {
    const t = schema.pushSubscription;
    expect(await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(t.id, bId)))).toEqual(
      [],
    );
    expect(
      await withHousehold(db, 'hA', (tx) =>
        tx.update(t).set({ userAgent: 'x' }).where(eq(t.id, bId)).returning(),
      ),
    ).toEqual([]);
    expect(
      await withHousehold(db, 'hA', (tx) => tx.delete(t).where(eq(t.id, bId)).returning()),
    ).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(t.id, bId))),
    ).toHaveLength(1);
  });

  it('push_subscription: WITH CHECK rejects a foreign household row and a move', async () => {
    const t = schema.pushSubscription;
    const insert = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(t).values(sub('hB', 'u1', 'https://push.example/x')),
      ),
    );
    expect(insert).toMatch(/row-level security/i);
    const moved = await pgError(
      withHousehold(db, 'hA', (tx) => tx.update(t).set({ householdId: 'hB' }).where(eq(t.id, aId))),
    );
    expect(moved).toMatch(/row-level security/i);
  });

  it('push_subscription: the endpoint is unique across households', async () => {
    const message = await pgError(
      withHousehold(db, 'hB', (tx) =>
        tx.insert(schema.pushSubscription).values(sub('hB', 'u2', 'https://push.example/a')),
      ),
    );
    expect(message).toMatch(/push_subscription_endpoint_unique/);
  });

  it('push_subscription defaults: failure_count 0, no success, no backoff', async () => {
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.pushSubscription).where(eq(schema.pushSubscription.id, aId)),
    );
    expect(row).toMatchObject({ failureCount: 0, lastSuccessAt: null, nextAttemptAt: null });
  });

  it('push_subscription.user_id references user(id): unknown users are rejected, deleting a user cascades', async () => {
    const t = schema.pushSubscription;
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(t).values(sub('hA', 'ghost', 'https://fcm.googleapis.com/ghost')),
      ),
    );
    expect(message).toMatch(/push_subscription_user_id_user_id_fk/);
    await db.insert(schema.user).values({ id: 'u3', name: 'u3', email: 'u3@example.test' });
    await withHousehold(db, 'hA', (tx) =>
      tx.insert(t).values(sub('hA', 'u3', 'https://fcm.googleapis.com/u3')),
    );
    await db.delete(schema.user).where(eq(schema.user.id, 'u3'));
    expect(
      await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(t.userId, 'u3'))),
    ).toEqual([]);
  });

  describe('member delete trigger', () => {
    const t = schema.pushSubscription;
    const devicesOf = (household: string, userId: string) =>
      withHousehold(db, household, (tx) =>
        tx.select({ endpoint: t.endpoint }).from(t).where(eq(t.userId, userId)),
      );

    it('drops that user devices of that household only, whatever path deletes the member', async () => {
      await db
        .insert(schema.user)
        .values(['m1', 'm2'].map((id) => ({ id, name: id, email: `${id}@example.test` })));
      await db.insert(schema.member).values(
        [
          ['mem-m1-hA', 'hA', 'm1'],
          ['mem-m1-hB', 'hB', 'm1'],
          ['mem-m2-hA', 'hA', 'm2'],
        ].map(([id, org, user]) => ({
          id: id!,
          organizationId: org!,
          userId: user!,
          role: 'member',
          createdAt: new Date(),
        })),
      );
      const add = (h: string, u: string) =>
        withHousehold(db, h, (tx) =>
          tx.insert(t).values(sub(h, u, `https://fcm.googleapis.com/fcm/send/${h}-${u}`)),
        );
      await add('hA', 'm1');
      await add('hB', 'm1');
      await add('hA', 'm2');

      // Plain delete by the app role, no household context: the trigger must still get through RLS.
      await db.delete(schema.member).where(eq(schema.member.id, 'mem-m1-hA'));

      expect(await devicesOf('hA', 'm1')).toEqual([]);
      expect(await devicesOf('hB', 'm1')).toHaveLength(1);
      expect(await devicesOf('hA', 'm2')).toHaveLength(1);
    });

    it('is a security definer function with a pinned search_path', async () => {
      const { rows } = await db.execute(
        sql`select p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'execute') as pub
            from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
            where tg.tgrelid = 'member'::regclass and not tg.tgisinternal
              and p.proname = 'drop_push_devices_of_member'`,
      );
      expect(rows).toEqual([
        { prosecdef: true, proconfig: ['search_path=pg_catalog, public'], pub: false },
      ]);
    });
  });

  describe('claim_push_endpoint (the one path that crosses households)', () => {
    const claim = (household: string, endpoint: string) =>
      withHousehold(db, household, (tx) =>
        tx.execute(sql`select claim_push_endpoint(${endpoint})`),
      );

    it('removes the endpoint from another household but never from the caller', async () => {
      await withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.pushSubscription).values(sub('hA', 'u1', 'https://push.example/moving')),
      );
      await claim('hA', 'https://push.example/moving');
      expect(
        await withHousehold(db, 'hA', (tx) =>
          tx
            .select()
            .from(schema.pushSubscription)
            .where(eq(schema.pushSubscription.endpoint, 'https://push.example/moving')),
        ),
      ).toHaveLength(1);
      await claim('hB', 'https://push.example/moving');
      expect(
        await withHousehold(db, 'hA', (tx) =>
          tx
            .select()
            .from(schema.pushSubscription)
            .where(eq(schema.pushSubscription.endpoint, 'https://push.example/moving')),
        ),
      ).toEqual([]);
    });

    it('does nothing without a household context and touches no other endpoint', async () => {
      await db.execute(sql`select claim_push_endpoint('https://push.example/a')`);
      expect(
        await withHousehold(db, 'hA', (tx) =>
          tx.select().from(schema.pushSubscription).where(eq(schema.pushSubscription.id, aId)),
        ),
      ).toHaveLength(1);
      await claim('hB', 'https://push.example/other');
      expect(
        await withHousehold(db, 'hA', (tx) =>
          tx.select().from(schema.pushSubscription).where(eq(schema.pushSubscription.id, aId)),
        ),
      ).toHaveLength(1);
    });

    it('is a security definer function with a pinned search_path, not executable by PUBLIC', async () => {
      const { rows } = await db.execute(
        sql`select prosecdef, proconfig, has_function_privilege('public', oid, 'execute') as pub
            from pg_proc where proname = 'claim_push_endpoint'`,
      );
      expect(rows).toEqual([
        { prosecdef: true, proconfig: ['search_path=pg_catalog, public'], pub: false },
      ]);
    });
  });

  describe('instance_secret', () => {
    it('is a global table without RLS that the app role reads and writes', async () => {
      const { rows } = await db.execute(
        sql`select relrowsecurity as rls from pg_class
            where relname = 'instance_secret' and relnamespace = 'public'::regnamespace`,
      );
      expect(rows).toEqual([{ rls: false }]);
      await db.insert(schema.instanceSecret).values({ name: 'probe', value: 'v' });
      expect(
        await db
          .select()
          .from(schema.instanceSecret)
          .where(eq(schema.instanceSecret.name, 'probe')),
      ).toEqual([{ name: 'probe', value: 'v', updatedAt: expect.any(Date), updatedBy: null }]);
    });

    it('rejects a duplicate name (insert ... on conflict do nothing is how callers race safely)', async () => {
      const message = await pgError(
        db.insert(schema.instanceSecret).values({ name: 'probe', value: 'w' }),
      );
      expect(message).toMatch(/duplicate key/i);
    });
  });

  describe('notification.pushed_at', () => {
    it('is a nullable timestamptz with a partial index on unpushed rows by created_at', async () => {
      const col = await db.execute(
        sql`select data_type, is_nullable from information_schema.columns
            where table_name = 'notification' and column_name = 'pushed_at'`,
      );
      expect(col.rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
      const idx = await db.execute(
        sql`select indexdef from pg_indexes where indexname = 'notification_unpushed_idx'`,
      );
      expect(idx.rows[0]?.indexdef).toMatch(/\(created_at\) WHERE \(pushed_at IS NULL\)/);
    });

    it('defaults to null on a new notification', async () => {
      const [row] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.notification)
          .values({ householdId: 'hA', kind: 'consent_expiring', payload: {} })
          .returning(),
      );
      expect(row?.pushedAt).toBeNull();
    });
  });
});
