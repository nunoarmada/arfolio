import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { subscribePush } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { PASSWORD, signInHeaders, testEnv as env } from '../test-utils';
import { acceptInvitationAndRegister, createInvitation, getInvitationPreview } from './invitations';
import { listMembers, listPendingInvitations, removeMember, revokeInvitation } from './members';
import { ForbiddenError } from './session';
import { completeSetup } from './setup';

describe('members management', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;
  let owner: Headers;
  let member: Headers;
  const deps = () => ({ db, auth });

  async function userId(email: string): Promise<string> {
    const [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    return row!.id;
  }
  async function memberId(email: string): Promise<string> {
    const [row] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, await userId(email)));
    return row!.id;
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
    owner = new Headers(await signInHeaders(auth, 'owner@example.com'));
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'owner@example.com'));
    // Invite a member through the real flow, so this also covers the invitation round trip.
    const invite = await createInvitation(
      { headers: owner, email: 'member@example.com', role: 'member' },
      deps(),
    );
    await acceptInvitationAndRegister(
      {
        invitationId: invite.invitationId,
        token: invite.token,
        name: 'Sam',
        password: PASSWORD,
      },
      deps(),
    );
    member = new Headers(await signInHeaders(auth, 'member@example.com'));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('lists the household members with roles and marks the caller', async () => {
    const rows = await listMembers(member, deps());
    expect(rows.map((r) => [r.email, r.role, r.isSelf])).toEqual([
      ['owner@example.com', 'owner', false],
      ['member@example.com', 'member', true],
    ]);
  });

  it('lists pending invitations for owners only', async () => {
    const pending = await createInvitation(
      { headers: owner, email: 'later@example.com', role: 'viewer' },
      deps(),
    );
    const rows = await listPendingInvitations(owner, deps());
    expect(rows).toEqual([
      expect.objectContaining({
        id: pending.invitationId,
        email: 'later@example.com',
        role: 'viewer',
      }),
    ]);
    await expect(listPendingInvitations(member, deps())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('revokes an invitation so its link stops working; members cannot revoke', async () => {
    const created = await createInvitation(
      { headers: owner, email: 'gone@example.com', role: 'member' },
      deps(),
    );
    await expect(revokeInvitation(member, created.invitationId, deps())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await getInvitationPreview(created.invitationId, created.token, { db })).not.toBeNull();

    await revokeInvitation(owner, created.invitationId, deps());
    expect(await getInvitationPreview(created.invitationId, created.token, { db })).toBeNull();
    expect((await listPendingInvitations(owner, deps())).map((r) => r.email)).not.toContain(
      'gone@example.com',
    );
  });

  it('refuses to revoke an invitation of another household', async () => {
    const otherOrg = 'other-household';
    await db.insert(schema.organization).values({
      id: otherOrg,
      name: 'Outra Casa',
      slug: 'outra-casa',
      createdAt: new Date(),
    });
    const inviter = await userId('owner@example.com');
    await db.insert(schema.invitation).values({
      id: 'other-invite',
      organizationId: otherOrg,
      email: 'someone@example.com',
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: inviter,
    });
    await expect(revokeInvitation(owner, 'other-invite', deps())).rejects.toThrow(
      /Invitation not found/,
    );
    const [row] = await db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, 'other-invite'));
    expect(row?.status).toBe('pending');
  });

  it('refuses removal by non-owners (403) and removal of yourself', async () => {
    await expect(
      removeMember(member, await memberId('owner@example.com'), deps()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(owner, await memberId('owner@example.com'), deps())).rejects.toThrow(
      /last owner|yourself/i,
    );
  });

  it('lets an owner remove a member, who then loses access', async () => {
    await removeMember(owner, await memberId('member@example.com'), deps());
    expect((await listMembers(owner, deps())).map((r) => r.email)).toEqual(['owner@example.com']);
    const memberships = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, householdId));
    expect(memberships).toHaveLength(1);
  });

  it('deletes the removed user when they have no other household, so they can be re-invited', async () => {
    expect(
      await db.select().from(schema.user).where(eq(schema.user.email, 'member@example.com')),
    ).toHaveLength(0);

    const again = await createInvitation(
      { headers: owner, email: 'member@example.com', role: 'member' },
      deps(),
    );
    await acceptInvitationAndRegister(
      { invitationId: again.invitationId, token: again.token, name: 'Alex', password: PASSWORD },
      deps(),
    );
    const back = new Headers(await signInHeaders(auth, 'member@example.com'));
    expect((await listMembers(back, deps())).map((r) => r.email)).toContain('member@example.com');
  });

  it('keeps the user when they still belong to another household', async () => {
    const otherOrg = 'second-household';
    await db.insert(schema.organization).values({
      id: otherOrg,
      name: 'Second Home',
      slug: 'second-home',
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: 'second-membership',
      organizationId: otherOrg,
      userId: await userId('member@example.com'),
      role: 'member',
      createdAt: new Date(),
    });

    const [home] = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.userId, await userId('member@example.com')),
          eq(schema.member.organizationId, householdId),
        ),
      );
    expect(home?.id).not.toBe('second-membership');

    // The member has a push device in each household; only the one of the household they are
    // removed from may go (the account lives on, so the FK cascade does not help here).
    const memberId = await userId('member@example.com');
    const device = (path: string) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${path}`,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });
    await subscribePush({ db, householdId, userId: memberId, role: 'member' }, device('home'));
    await subscribePush(
      { db, householdId: otherOrg, userId: memberId, role: 'member' },
      device('away'),
    );

    await removeMember(owner, home!.id, deps());

    const devicesIn = (household: string) =>
      withHousehold(db, household, (tx) =>
        tx
          .select({ endpoint: schema.pushSubscription.endpoint })
          .from(schema.pushSubscription)
          .where(eq(schema.pushSubscription.userId, memberId)),
      );
    expect(await devicesIn(householdId)).toEqual([]);
    expect(await devicesIn(otherOrg)).toEqual([
      { endpoint: 'https://fcm.googleapis.com/fcm/send/away' },
    ]);

    expect(
      await db.select().from(schema.user).where(eq(schema.user.email, 'member@example.com')),
    ).toHaveLength(1);
  });

  describe('push devices when a membership ends through Better Auth directly', () => {
    const device = (path: string) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/${path}`,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });
    const devicesOf = (household: string, uid: string) =>
      withHousehold(db, household, (tx) =>
        tx
          .select({ endpoint: schema.pushSubscription.endpoint })
          .from(schema.pushSubscription)
          .where(eq(schema.pushSubscription.userId, uid)),
      );

    async function invited(email: string): Promise<{ headers: Headers; uid: string }> {
      const inv = await createInvitation({ headers: owner, email, role: 'member' }, deps());
      await acceptInvitationAndRegister(
        { invitationId: inv.invitationId, token: inv.token, name: email, password: PASSWORD },
        deps(),
      );
      return { headers: new Headers(await signInHeaders(auth, email)), uid: await userId(email) };
    }

    it.each(['leave', 'remove-member'] as const)(
      'POST /organization/%s drops the devices of that household only',
      async (path) => {
        const email = `${path}@example.com`;
        const { headers, uid } = await invited(email);
        const other = `other-${path}`;
        await db
          .insert(schema.organization)
          .values({ id: other, name: other, slug: other, createdAt: new Date() });
        await db.insert(schema.member).values({
          id: `m-${other}`,
          organizationId: other,
          userId: uid,
          role: 'member',
          createdAt: new Date(),
        });
        const mine = { db, userId: uid, role: 'member' as const };
        await subscribePush({ ...mine, householdId }, device(`${path}-home`));
        await subscribePush({ ...mine, householdId: other }, device(`${path}-away`));

        if (path === 'leave') {
          await auth.api.leaveOrganization({ headers, body: { organizationId: householdId } });
        } else {
          await auth.api.removeMember({
            headers: owner,
            body: { memberIdOrEmail: await memberId(email), organizationId: householdId },
          });
        }

        expect(await devicesOf(householdId, uid)).toEqual([]);
        expect(await devicesOf(other, uid)).toHaveLength(1);
      },
    );
  });
});
