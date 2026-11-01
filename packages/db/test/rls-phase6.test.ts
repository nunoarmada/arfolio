import { createHash } from 'node:crypto';
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

const hash = (token: string) => createHash('sha256').update(token).digest();
const pat = (householdId: string, userId: string, token: string) => ({
  householdId,
  userId,
  name: 'n',
  tokenHash: hash(token),
  prefix: token.slice(0, 12),
  scope: 'read',
});
const audit = (householdId: string, action: string) => ({ householdId, actor: 'mcp', action });

describe('phase 6 schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let patA: string;
  let auditA: string;

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
    [{ id: patA }] = (await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.personalAccessToken)
        .values(pat('hA', 'u1', 'pfm_pat_tokenA'))
        .returning({ id: schema.personalAccessToken.id }),
    )) as [{ id: string }];
    await withHousehold(db, 'hB', (tx) =>
      tx.insert(schema.personalAccessToken).values(pat('hB', 'u2', 'pfm_pat_tokenB')),
    );
    [{ id: auditA }] = (await withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.auditLog).values(audit('hA', 'a')).returning({ id: schema.auditLog.id }),
    )) as [{ id: string }];
    await withHousehold(db, 'hB', (tx) => tx.insert(schema.auditLog).values(audit('hB', 'b')));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it.each(['audit_log', 'personal_access_token'])(
    '%s has RLS enabled with the standard household_isolation policy',
    async (table) => {
      const expected = "(household_id = current_setting('app.household_id'::text, true))";
      const { rows } = await db.execute(
        sql`select c.relrowsecurity as rls, p.qual, p.with_check
            from pg_class c join pg_policies p on p.tablename = c.relname
            where c.relname = ${table} and p.policyname = 'household_isolation'`,
      );
      expect(rows).toEqual([{ rls: true, qual: expected, with_check: expected }]);
    },
  );

  it('isolates rows by household for both tables, and WITH CHECK rejects a foreign row', async () => {
    const p = schema.personalAccessToken;
    const l = schema.auditLog;
    expect(await withHousehold(db, 'hB', (tx) => tx.select().from(p))).toHaveLength(1);
    expect(await withHousehold(db, 'hB', (tx) => tx.select().from(l))).toHaveLength(1);
    expect(await db.select().from(p)).toEqual([]);
    expect(await db.select().from(l)).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) =>
        tx.update(p).set({ name: 'x' }).where(eq(p.id, patA)).returning(),
      ),
    ).toEqual([]);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) => tx.insert(p).values(pat('hB', 'u1', 'pfm_pat_other'))),
      ),
    ).toMatch(/row-level security/i);
    expect(
      await pgError(withHousehold(db, 'hA', (tx) => tx.insert(l).values(audit('hB', 'x')))),
    ).toMatch(/row-level security/i);
  });

  it('audit_log is append-only for the app role and checks the actor', async () => {
    const l = schema.auditLog;
    expect(
      await pgError(withHousehold(db, 'hA', (tx) => tx.update(l).set({ action: 'x' }))),
    ).toMatch(/permission denied/);
    expect(
      await pgError(withHousehold(db, 'hA', (tx) => tx.delete(l).where(eq(l.id, auditA)))),
    ).toMatch(/permission denied/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) => tx.insert(l).values({ ...audit('hA', 'x'), actor: 'bot' })),
      ),
    ).toMatch(/audit_log_actor_check/);
  });

  it('personal_access_token: token_hash is unique, name and scope are checked, user cascades', async () => {
    const p = schema.personalAccessToken;
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) => tx.insert(p).values(pat('hA', 'u1', 'pfm_pat_tokenB'))),
      ),
    ).toMatch(/personal_access_token_token_hash_unique/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(p).values({ ...pat('hA', 'u1', 'pfm_pat_n1'), name: '' }),
        ),
      ),
    ).toMatch(/personal_access_token_name_check/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(p).values({ ...pat('hA', 'u1', 'pfm_pat_n2'), name: 'x'.repeat(61) }),
        ),
      ),
    ).toMatch(/personal_access_token_name_check/);
    expect(
      await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(p).values({ ...pat('hA', 'u1', 'pfm_pat_n3'), scope: 'admin' }),
        ),
      ),
    ).toMatch(/personal_access_token_scope_check/);
    await db.insert(schema.user).values({ id: 'u3', name: 'u3', email: 'u3@example.test' });
    await withHousehold(db, 'hA', (tx) => tx.insert(p).values(pat('hA', 'u3', 'pfm_pat_u3')));
    await db.delete(schema.user).where(eq(schema.user.id, 'u3'));
    expect(
      await withHousehold(db, 'hA', (tx) => tx.select().from(p).where(eq(p.userId, 'u3'))),
    ).toEqual([]);
  });

  it('audit_log.user_id is set to null when the user is deleted', async () => {
    const l = schema.auditLog;
    await db.insert(schema.user).values({ id: 'u4', name: 'u4', email: 'u4@example.test' });
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(l)
        .values({ ...audit('hA', 'by-u4'), userId: 'u4' })
        .returning({ id: l.id }),
    );
    await db.delete(schema.user).where(eq(schema.user.id, 'u4'));
    const [after] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(l).where(eq(l.id, row!.id)),
    );
    expect(after).toMatchObject({ userId: null, action: 'by-u4' });
  });

  describe('pat_lookup', () => {
    const lookup = (token: string, household?: string) =>
      household
        ? withHousehold(db, household, (tx) =>
            tx.execute(sql`select * from pat_lookup(${hash(token)})`),
          )
        : db.execute(sql`select * from pat_lookup(${hash(token)})`);

    it('finds a token by hash without a household and returns only the lookup columns', async () => {
      const { rows } = await lookup('pfm_pat_tokenA');
      expect(rows).toEqual([
        {
          id: patA,
          household_id: 'hA',
          user_id: 'u1',
          scope: 'read',
          expires_at: null,
          revoked_at: null,
        },
      ]);
      expect((await lookup('pfm_pat_tokenB', 'hA')).rows).toHaveLength(1);
      expect((await lookup('pfm_pat_unknown')).rows).toEqual([]);
    });

    it('is a stable security definer function with a pinned search_path, not executable by PUBLIC', async () => {
      const { rows } = await db.execute(
        sql`select p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'execute') as pub,
                   has_function_privilege('pfm_app', p.oid, 'execute') as app
            from pg_proc p where p.proname = 'pat_lookup'`,
      );
      expect(rows).toEqual([
        { prosecdef: true, proconfig: ['search_path=pg_catalog, public'], pub: false, app: true },
      ]);
    });
  });

  it('member delete trigger drops that user PATs of that household only, with no household context', async () => {
    const p = schema.personalAccessToken;
    await db.insert(schema.member).values(
      [
        ['mem-u1-hA', 'hA'],
        ['mem-u1-hB', 'hB'],
      ].map(([id, org]) => ({
        id: id!,
        organizationId: org!,
        userId: 'u1',
        role: 'member',
        createdAt: new Date(),
      })),
    );
    await withHousehold(db, 'hB', (tx) => tx.insert(p).values(pat('hB', 'u1', 'pfm_pat_u1B')));
    await db.delete(schema.member).where(eq(schema.member.id, 'mem-u1-hA'));
    expect(
      await withHousehold(db, 'hA', (tx) => tx.select().from(p).where(eq(p.userId, 'u1'))),
    ).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) => tx.select().from(p).where(eq(p.userId, 'u1'))),
    ).toHaveLength(1);
    const { rows } = await db.execute(
      sql`select p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'execute') as pub
          from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
          where tg.tgrelid = 'member'::regclass and not tg.tgisinternal
            and p.proname = 'drop_pats_of_member'`,
    );
    expect(rows).toEqual([
      { prosecdef: true, proconfig: ['search_path=pg_catalog, public'], pub: false },
    ]);
    const grants = await db.execute(
      sql`select p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'execute') as pub
          from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
          where tg.tgrelid = 'member'::regclass and not tg.tgisinternal
            and p.proname = 'drop_oauth_grants_of_member'`,
    );
    expect(grants.rows).toEqual([
      { prosecdef: true, proconfig: ['search_path=pg_catalog, public'], pub: false },
    ]);
  });
});
