import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { PASSWORD, post, signInHeaders, testEnv as env } from '../test-utils';
import {
  acceptInvitationAndRegister,
  createInvitation,
  hashInvitationToken,
  InvalidInvitationError,
  NotAllowedError,
  TwoFactorRequiredError,
} from './invitations';
import { completeSetup, InvalidSetupTokenError, isSetupOpen, SetupClosedError } from './setup';

const owner = {
  token: env.SETUP_TOKEN,
  name: 'Owner One',
  email: 'owner@example.com',
  password: PASSWORD,
  householdName: 'Casa Silva',
  locale: 'pt-PT',
};

describe('setup and invitations', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let ownerClient: pg.Client;

  const userCount = async () => (await db.select().from(schema.user)).length;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 8 });
    db = app.db;
    close = () => app.pool.end();
    auth = createAuth({ db, env });
    ownerClient = new pg.Client({ connectionString: testDb.ownerUrl });
    await ownerClient.connect();
  });

  afterAll(async () => {
    await ownerClient?.end();
    await close?.();
    await testDb?.drop();
  });

  it('is open while there are no users', async () => {
    await expect(isSetupOpen(db)).resolves.toBe(true);
  });

  it('rejects a wrong token and creates nothing', async () => {
    await expect(
      completeSetup({ ...owner, token: 'x'.repeat(29) }, { db, auth, env }),
    ).rejects.toBeInstanceOf(InvalidSetupTokenError);
    expect(await userCount()).toBe(0);
    expect(await db.select().from(schema.organization)).toHaveLength(0);
  });

  it('treats a missing or non-string token as an invalid token', async () => {
    for (const token of [undefined, null, 42, { toString: () => env.SETUP_TOKEN }]) {
      await expect(
        completeSetup({ ...owner, token: token as unknown as string }, { db, auth, env }),
      ).rejects.toBeInstanceOf(InvalidSetupTokenError);
    }
    expect(await userCount()).toBe(0);
  });

  it('rolls back the user when a later step fails, keeping setup open', async () => {
    await ownerClient.query(`
      create function fail_settings() returns trigger language plpgsql as
      $$ begin raise exception 'boom'; end $$;
      create trigger fail_settings before insert on household_settings
        for each row execute function fail_settings();`);
    try {
      await expect(completeSetup(owner, { db, auth, env })).rejects.toThrow();
    } finally {
      await ownerClient.query(
        'drop trigger fail_settings on household_settings; drop function fail_settings();',
      );
    }
    expect(await userCount()).toBe(0);
    expect(await db.select().from(schema.organization)).toHaveLength(0);
    await expect(isSetupOpen(db)).resolves.toBe(true);
  });

  it('rolls everything back when seeding the category templates fails', async () => {
    await ownerClient.query(`
      create function fail_seed() returns trigger language plpgsql as
      $$ begin raise exception 'seed-boom'; end $$;
      create trigger fail_seed before insert on category_group
        for each row execute function fail_seed();`);
    try {
      const error = await completeSetup(owner, { db, auth, env }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).toContain('seed-boom');
    } finally {
      await ownerClient.query(
        'drop trigger fail_seed on category_group; drop function fail_seed();',
      );
    }
    expect(await userCount()).toBe(0);
    expect(await db.select().from(schema.organization)).toHaveLength(0);
    await expect(isSetupOpen(db)).resolves.toBe(true);
  });

  it('reports the original error when the cleanup also fails', async () => {
    // Settings insert fails; the user delete then fails too (trigger), which must not mask it.
    await ownerClient.query(`
      create function fail_settings() returns trigger language plpgsql as
      $$ begin raise exception 'original-boom'; end $$;
      create trigger fail_settings before insert on household_settings
        for each row execute function fail_settings();
      create function fail_user_delete() returns trigger language plpgsql as
      $$ begin raise exception 'cleanup-boom'; end $$;
      create trigger fail_user_delete before delete on "user"
        for each row execute function fail_user_delete();`);
    try {
      const error = await completeSetup(owner, { db, auth, env }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).toContain('original-boom');
      expect(String(error)).not.toContain('cleanup-boom');
    } finally {
      await ownerClient.query(`
        drop trigger fail_settings on household_settings; drop function fail_settings();
        drop trigger fail_user_delete on "user"; drop function fail_user_delete();`);
      // Remove what the failed cleanup left behind so the next test starts from a clean slate.
      await ownerClient.query('delete from organization; delete from "user"');
    }
  });

  it('lets at most one of two concurrent setups succeed', async () => {
    const results = await Promise.allSettled([
      completeSetup(owner, { db, auth, env }),
      completeSetup({ ...owner, email: 'other@example.com' }, { db, auth, env }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect(await userCount()).toBeLessThanOrEqual(1);
    // Whatever the race left behind, start the next test from a clean slate.
    await ownerClient.query('delete from organization; delete from "user"');
    await expect(isSetupOpen(db)).resolves.toBe(true);
  });

  it('creates the user, the household, its settings and an owner membership', async () => {
    const { userId, householdId } = await completeSetup(
      { ...owner, currency: 'USD', timezone: 'America/Sao_Paulo', fiscalYearStartMonth: 4 },
      { db, auth, env },
    );

    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
    expect(user?.email).toBe('owner@example.com');
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, householdId));
    expect(org?.name).toBe('Casa Silva');
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, householdId));
    expect(member).toMatchObject({ userId, role: 'owner' });
    const settings = await withHousehold(db, householdId, (tx) =>
      tx.select().from(schema.householdSettings),
    );
    expect(settings).toMatchObject([
      {
        householdId,
        locale: 'pt-PT',
        currency: 'USD',
        timezone: 'America/Sao_Paulo',
        fiscalYearStartMonth: 4,
      },
    ]);

    // Category templates are seeded in the household locale (pt-PT here).
    const groups = await withHousehold(db, householdId, (tx) =>
      tx.select({ name: schema.categoryGroup.name }).from(schema.categoryGroup),
    );
    expect(groups.map((g) => g.name)).toContain('Receitas');
    expect(groups).toHaveLength(10);

    const signIn = await post(auth, '/sign-in/email', {
      email: 'owner@example.com',
      password: owner.password,
    });
    expect(signIn.status).toBe(200);
  });

  it('closes setup after the first user exists', async () => {
    await expect(isSetupOpen(db)).resolves.toBe(false);
    await expect(
      completeSetup({ ...owner, email: 'second@example.com' }, { db, auth, env }),
    ).rejects.toBeInstanceOf(SetupClosedError);
  });

  it('rejects public sign-up through the HTTP endpoint', async () => {
    const res = await post(auth, '/sign-up/email', {
      name: 'Eve',
      email: 'eve@example.com',
      password: PASSWORD,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'eve@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('does not expose admin user creation over HTTP, even to a user whose role is admin', async () => {
    await db
      .update(schema.user)
      .set({ role: 'admin' })
      .where(eq(schema.user.email, 'owner@example.com'));
    const headers = await signInHeaders(auth, 'owner@example.com');
    const res = await post(
      auth,
      '/admin/create-user',
      { name: 'Eve', email: 'eve@example.com', password: PASSWORD },
      headers,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await userCount()).toBe(1);
  });

  it('refuses to create a user outside the setup and invitation flows', async () => {
    await expect(
      auth.api.createUser({
        body: { name: 'X', email: 'x@example.com', password: PASSWORD },
      }),
    ).rejects.toThrow();
    expect(await userCount()).toBe(1);
  });

  describe('invitations', () => {
    const DAY = 86_400_000;

    /** Inserts an invitation plus its registration token and returns the raw token. */
    const invite = async (
      id: string,
      email: string,
      opts: { role?: string | null; status?: string; expiresAt?: Date; token?: string } = {},
    ): Promise<string> => {
      const [u] = await db.select().from(schema.user);
      const [m] = await db.select().from(schema.member);
      const expiresAt = opts.expiresAt ?? new Date(Date.now() + DAY);
      await db.insert(schema.invitation).values({
        id,
        organizationId: m!.organizationId,
        email,
        role: opts.role === undefined ? 'member' : opts.role,
        status: opts.status ?? 'pending',
        expiresAt,
        inviterId: u!.id,
      });
      const token = opts.token ?? `token-${id}`;
      await db
        .insert(schema.invitationToken)
        .values({ invitationId: id, tokenHash: hashInvitationToken(token), expiresAt });
      return token;
    };

    const register = (invitationId: string, token: string, name = 'Kay') =>
      acceptInvitationAndRegister({ invitationId, token, name, password: PASSWORD }, { db, auth });

    it('registers the invited email, adds the membership with the invited role and accepts it', async () => {
      const token = await invite('inv-k', 'sam@example.com', { role: 'viewer' });
      const { userId, householdId } = await register('inv-k', token);

      const [user] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
      expect(user?.email).toBe('sam@example.com');
      const [member] = await db
        .select()
        .from(schema.member)
        .where(eq(schema.member.userId, userId));
      expect(member).toMatchObject({ organizationId: householdId, role: 'viewer' });
      const [inv] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, 'inv-k'));
      expect(inv?.status).toBe('accepted');
      const signIn = await post(auth, '/sign-in/email', {
        email: 'sam@example.com',
        password: PASSWORD,
      });
      expect(signIn.status).toBe(200);
    });

    it('cannot be replayed with the same token', async () => {
      await expect(register('inv-k', 'token-inv-k', 'Mallory')).rejects.toBeInstanceOf(
        InvalidInvitationError,
      );
    });

    it('fails with only the invitation id', async () => {
      await invite('inv-noid', 'noid@example.com');
      const before = await userCount();
      await expect(
        acceptInvitationAndRegister(
          { invitationId: 'inv-noid', name: 'X', password: PASSWORD } as never,
          { db, auth },
        ),
      ).rejects.toThrow();
      expect(await userCount()).toBe(before);
    });

    it('fails with a wrong token and leaves the invitation usable', async () => {
      await invite('inv-wrong', 'wrong@example.com');
      const before = await userCount();
      await expect(register('inv-wrong', 'not-the-token')).rejects.toBeInstanceOf(
        InvalidInvitationError,
      );
      expect(await userCount()).toBe(before);
      await expect(register('inv-wrong', 'token-inv-wrong')).resolves.toMatchObject({
        role: 'member',
      });
    });

    it('does not accept the token of another invitation', async () => {
      await invite('inv-a', 'a@example.com');
      await invite('inv-b', 'b@example.com');
      await expect(register('inv-a', 'token-inv-b')).rejects.toBeInstanceOf(InvalidInvitationError);
    });

    it('rejects an expired token even when the invitation is still pending', async () => {
      await invite('inv-tok-exp', 'tokexp@example.com');
      await db
        .update(schema.invitationToken)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.invitationToken.invitationId, 'inv-tok-exp'));
      await expect(register('inv-tok-exp', 'token-inv-tok-exp')).rejects.toBeInstanceOf(
        InvalidInvitationError,
      );
    });

    it('rejects expired, cancelled, role-less and unknown invitations without creating users', async () => {
      await invite('inv-old', 'old@example.com', { expiresAt: new Date(Date.now() - 1000) });
      await invite('inv-cancelled', 'cancelled@example.com', { status: 'canceled' });
      await invite('inv-norole', 'norole@example.com', { role: null });
      const before = await userCount();
      for (const id of ['inv-old', 'inv-cancelled', 'inv-norole']) {
        await expect(register(id, `token-${id}`)).rejects.toBeInstanceOf(InvalidInvitationError);
      }
      await expect(register('nope', 'whatever')).rejects.toBeInstanceOf(InvalidInvitationError);
      expect(await userCount()).toBe(before);
    });

    it('does not create the account if the invited email already has one', async () => {
      await invite('inv-dup', 'sam@example.com');
      await expect(register('inv-dup', 'token-inv-dup', 'K2')).rejects.toThrow();
      const [inv] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, 'inv-dup'));
      expect(inv?.status).toBe('pending');
      const [tok] = await db
        .select()
        .from(schema.invitationToken)
        .where(eq(schema.invitationToken.invitationId, 'inv-dup'));
      expect(tok?.usedAt).toBeNull();
    });

    describe('createInvitation', () => {
      it('is limited to owners', async () => {
        const headers = new Headers(await signInHeaders(auth, 'sam@example.com'));
        await expect(
          createInvitation({ headers, email: 'z@example.com', role: 'member' }, { db, auth }),
        ).rejects.toBeInstanceOf(NotAllowedError);
      });

      it('requires owners to have 2FA enabled', async () => {
        const headers = new Headers(await signInHeaders(auth, 'owner@example.com'));
        await db
          .update(schema.user)
          .set({ twoFactorEnabled: false })
          .where(eq(schema.user.email, 'owner@example.com'));
        await expect(
          createInvitation({ headers, email: 'nofa@example.com', role: 'member' }, { db, auth }),
        ).rejects.toBeInstanceOf(TwoFactorRequiredError);
      });

      it('returns a one-time token, stores only its hash and lets the invitee register', async () => {
        const headers = new Headers(await signInHeaders(auth, 'owner@example.com'));
        await db
          .update(schema.user)
          .set({ twoFactorEnabled: true })
          .where(eq(schema.user.email, 'owner@example.com'));
        const sent: string[] = [];
        const created = await createInvitation(
          { headers, email: 'Zed@Example.com', role: 'member' },
          { db, auth, sendInvitationEmail: async ({ link }) => void sent.push(link) },
        );
        expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(created.path).toBe(`/invite/${created.invitationId}?t=${created.token}`);
        expect(sent).toEqual([created.path]);

        const [stored] = await db
          .select()
          .from(schema.invitationToken)
          .where(eq(schema.invitationToken.invitationId, created.invitationId));
        expect(stored?.tokenHash).toBe(hashInvitationToken(created.token));
        expect(stored?.tokenHash).not.toContain(created.token);

        const result = await register(created.invitationId, created.token, 'Zed');
        expect(result.role).toBe('member');
        const [user] = await db.select().from(schema.user).where(eq(schema.user.id, result.userId));
        expect(user?.email).toBe('zed@example.com');
      });
    });
  });
});
