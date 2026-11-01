import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { PASSWORD, signInHeaders, testEnv as env } from '../test-utils';
import { acceptInvitationAndRegister, hashInvitationToken } from './invitations';
import { ForbiddenError, getSessionContext, requireMember, StaleSessionError } from './session';
import { completeSetup } from './setup';

/** Redirects and 404s from next/navigation are thrown errors carrying a digest. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { digest?: string }).digest ?? String(error);
  }
  return 'ok';
}

describe('session context', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;

  const headersFor = async (email: string) => new Headers(await signInHeaders(auth, email));
  const deps = () => ({ db, auth });

  /** Registers a user through the invitation flow; each test creates the users it needs. */
  async function addMember(email: string, role: string): Promise<void> {
    const [owner] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'owner@example.com'));
    const id = `inv-${email}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await db
      .insert(schema.invitation)
      .values({ id, organizationId: householdId, email, role, expiresAt, inviterId: owner!.id });
    await db
      .insert(schema.invitationToken)
      .values({ invitationId: id, tokenHash: hashInvitationToken('t'), expiresAt });
    await acceptInvitationAndRegister(
      { invitationId: id, token: 't', name: email, password: PASSWORD },
      deps(),
    );
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    db = app.db;
    close = () => app.pool.end();
    auth = createAuth({ db, env });
    ({ householdId } = await completeSetup(
      {
        token: env.SETUP_TOKEN,
        name: 'Owner',
        email: 'owner@example.com',
        password: PASSWORD,
        householdName: 'Casa',
        locale: 'pt-PT',
      },
      { db, auth, env },
    ));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('returns null without a session', async () => {
    await expect(getSessionContext(new Headers(), deps())).resolves.toBeNull();
  });

  it('returns the user, session, household and role for a member', async () => {
    await addMember('ctx-member@example.com', 'member');
    const ctx = await getSessionContext(await headersFor('ctx-member@example.com'), deps());
    expect(ctx).toMatchObject({
      user: { email: 'ctx-member@example.com' },
      householdId,
      role: 'member',
    });
    expect(ctx?.session.token).toBeTruthy();
  });

  it('redirects anonymous visitors to /sign-in', async () => {
    expect(await outcome(requireMember(new Headers(), undefined, deps()))).toContain('/sign-in');
  });

  it('redirects an owner without 2FA to /two-factor/setup, and lets one with 2FA through', async () => {
    const headers = await headersFor('owner@example.com');
    expect(await outcome(requireMember(headers, undefined, deps()))).toContain('/two-factor/setup');

    // The session was created first: once 2FA is enabled, sign-in would demand a second factor.
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'owner@example.com'));
    await expect(requireMember(headers, undefined, deps())).resolves.toMatchObject({
      role: 'owner',
      householdId,
    });
  });

  it('returns 404 when the role is not allowed', async () => {
    await addMember('role-viewer@example.com', 'viewer');
    const headers = await headersFor('role-viewer@example.com');
    expect(await outcome(requireMember(headers, { roles: ['owner', 'member'] }, deps()))).toContain(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
    await expect(requireMember(headers, { roles: ['viewer'] }, deps())).resolves.toMatchObject({
      role: 'viewer',
    });
  });

  it('requires a recent sign-in when asked for a fresh session', async () => {
    await addMember('fresh-member@example.com', 'member');
    const headers = await headersFor('fresh-member@example.com');
    await expect(requireMember(headers, { fresh: true }, deps())).resolves.toMatchObject({
      role: 'member',
    });

    const [user] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'fresh-member@example.com'));
    await db
      .update(schema.session)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.session.userId, user!.id));
    await expect(requireMember(headers, { fresh: true }, deps())).rejects.toBeInstanceOf(
      StaleSessionError,
    );
    // Without the option an older session is as good as ever.
    await expect(requireMember(headers, undefined, deps())).resolves.toMatchObject({
      role: 'member',
    });
  });

  it('raises a 403 ForbiddenError when an action is denied to the role', async () => {
    await addMember('action-viewer@example.com', 'viewer');
    const headers = await headersFor('action-viewer@example.com');
    const denied = requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, deps());
    await expect(denied).rejects.toBeInstanceOf(ForbiddenError);
    await expect(denied).rejects.toMatchObject({ status: 403 });
    // Pages keep answering 404 so a viewer cannot tell an owner-only page exists.
    expect(await outcome(requireMember(headers, { roles: ['owner'] }, deps()))).toContain(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
  });

  it('returns 404 for a signed-in user who belongs to no household', async () => {
    await addMember('orphan@example.com', 'member');
    await db
      .delete(schema.member)
      .where(
        eq(
          schema.member.userId,
          (
            await db.select().from(schema.user).where(eq(schema.user.email, 'orphan@example.com'))
          )[0]!.id,
        ),
      );
    const headers = await headersFor('orphan@example.com');
    await expect(getSessionContext(headers, deps())).resolves.toBeNull();
    expect(await outcome(requireMember(headers, undefined, deps()))).toContain(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
  });
});
