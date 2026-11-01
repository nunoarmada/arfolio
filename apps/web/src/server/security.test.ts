import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { totp } from '../../e2e/totp';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import {
  cookieOf,
  freshIp,
  get,
  PASSWORD,
  post,
  signInHeaders,
  testEnv as env,
} from '../test-utils';
import { acceptInvitationAndRegister, hashInvitationToken } from './invitations';
import { completeSetup } from './setup';

describe('auth hardening', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;

  const wrongPassword = (email: string, headers: Record<string, string> = {}) =>
    post(auth, '/sign-in/email', { email, password: 'wrong-password-123' }, headers);

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
      { db, auth },
    );
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 8 });
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
    await addMember('member@example.com', 'member');
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  describe('sign-in rate limit', () => {
    it('keys on the configured proxy header and ignores a client-supplied X-Forwarded-For', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await wrongPassword('nobody-a@example.com', {
          'x-real-ip': ip,
          'x-forwarded-for': `203.0.113.${i}`, // spoofed, different every time
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('gives clients with different X-Real-Ip separate buckets', async () => {
      const a = freshIp();
      for (let i = 0; i < 5; i++) await wrongPassword('nobody-b@example.com', { 'x-real-ip': a });
      expect((await wrongPassword('nobody-b@example.com', { 'x-real-ip': a })).status).toBe(429);
      const other = await wrongPassword('nobody-b@example.com', { 'x-real-ip': freshIp() });
      expect(other.status).toBe(401);
    });

    it('does not let spoofed X-Forwarded-For values escape the bucket either', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i++) await wrongPassword('nobody-c@example.com', { 'x-real-ip': ip });
      const res = await wrongPassword('nobody-c@example.com', {
        'x-real-ip': ip,
        'x-forwarded-for': '198.51.100.99',
      });
      expect(res.status).toBe(429);
    });
  });

  describe('sign-in lockout (per email and client IP, plus a per-email ceiling)', () => {
    let seq = 0;
    /** Each test gets its own registered user so no test depends on another's failures. */
    const newUser = async (): Promise<string> => {
      seq += 1;
      const email = `lock${seq}@example.com`;
      await addMember(email, 'member');
      return email;
    };
    /** Server-side sign-in: goes through the hooks but not the per-IP HTTP rate limiter. */
    const signIn = async (email: string, password: string, ip: string) => {
      try {
        await auth.api.signInEmail({
          body: { email, password },
          headers: new Headers({ 'x-real-ip': ip }),
        });
        return { status: 200, json: async () => ({}) };
      } catch (error) {
        const e = error as { statusCode?: number; body?: unknown };
        return { status: e.statusCode ?? 500, json: async () => e.body };
      }
    };
    const failures = (email: string) =>
      db.select().from(schema.signInFailure).where(eq(schema.signInFailure.email, email));

    it('locks one client IP after 10 failures, even for the right password', async () => {
      const email = await newUser();
      const ip = freshIp();
      for (let i = 0; i < 10; i++)
        expect((await signIn(email, 'wrong-password-1', ip)).status).toBe(401);
      const locked = await signIn(email, PASSWORD, ip);
      const wrong = await signIn(email, 'wrong-password-1', ip);
      expect(locked.status).toBe(401);
      expect(await locked.json()).toEqual(await wrong.json());
    });

    it('does not lock the same account for a different client IP', async () => {
      const email = await newUser();
      const attacker = freshIp();
      for (let i = 0; i < 10; i++) await signIn(email, 'wrong-password-1', attacker);
      expect((await signIn(email, PASSWORD, attacker)).status).toBe(401);
      expect((await signIn(email, PASSWORD, freshIp())).status).toBe(200);
    });

    it('lets at most 10 of 15 concurrent attempts from one IP reach verification', async () => {
      const email = await newUser();
      const ip = freshIp();
      const results = await Promise.all(
        Array.from({ length: 15 }, () => signIn(email, 'wrong-password-1', ip)),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      // An attempt is recorded before verification, so recorded rows = attempts that got through.
      expect(await failures(email)).toHaveLength(10);
      expect((await signIn(email, PASSWORD, ip)).status).toBe(401);
    });

    it('enforces the per-email ceiling of 50 across many IPs', async () => {
      const email = await newUser();
      await db
        .insert(schema.signInFailure)
        .values(Array.from({ length: 49 }, () => ({ email, ip: freshIp() })));
      // 49 < 50: one more attempt is still allowed (and succeeds with the right password).
      expect((await signIn(email, PASSWORD, freshIp())).status).toBe(200);

      const other = await newUser();
      await db
        .insert(schema.signInFailure)
        .values(Array.from({ length: 50 }, () => ({ email: other, ip: freshIp() })));
      expect((await signIn(other, PASSWORD, freshIp())).status).toBe(401);
    });

    describe('known-device cookie', () => {
      const COOKIE = /^pfm_kd_/;
      /** HTTP sign-in (its own client IP): the response and the known-device Set-Cookie, if any. */
      const httpSignIn = async (email: string, password: string, headers = {}) => {
        const res = await post(auth, '/sign-in/email', { email, password }, headers);
        const raw = res.headers.getSetCookie().find((c) => COOKIE.test(c));
        return { res, raw, cookie: raw?.split(';')[0] };
      };
      const flood = (email: string, count = 50) =>
        db
          .insert(schema.signInFailure)
          .values(Array.from({ length: count }, () => ({ email, ip: freshIp() })));

      it('sets an HttpOnly, Secure, SameSite=Lax cookie that lasts about 180 days', async () => {
        const email = await newUser();
        const { raw } = await httpSignIn(email, PASSWORD);
        expect(raw).toBeDefined();
        expect(raw).toMatch(/HttpOnly/i);
        expect(raw).toMatch(/Secure/i);
        expect(raw).toMatch(/SameSite=Lax/i);
        expect(Number(/Max-Age=(\d+)/i.exec(raw!)![1])).toBe(180 * 24 * 3600);
      });

      it('does not set it after a failed sign-in', async () => {
        const email = await newUser();
        const { raw } = await httpSignIn(email, 'wrong-password-1');
        expect(raw).toBeUndefined();
      });

      it('lets that device sign in while the per-email ceiling is reached, other devices stay locked', async () => {
        const email = await newUser();
        const { cookie } = await httpSignIn(email, PASSWORD);
        await flood(email);
        expect((await httpSignIn(email, PASSWORD)).res.status).toBe(401);
        expect((await httpSignIn(email, PASSWORD, { cookie: cookie! })).res.status).toBe(200);
      });

      it('has a higher per-email budget (200), not an unlimited one', async () => {
        const email = await newUser();
        const { cookie } = await httpSignIn(email, PASSWORD);
        await flood(email, 199);
        expect((await httpSignIn(email, PASSWORD, { cookie: cookie! })).res.status).toBe(200);
        await flood(email, 1);
        expect((await httpSignIn(email, PASSWORD, { cookie: cookie! })).res.status).toBe(401);
      });

      it('stops working after the password changes', async () => {
        const email = await newUser();
        const first = await post(auth, '/sign-in/email', { email, password: PASSWORD });
        const old = first.headers
          .getSetCookie()
          .find((c) => COOKIE.test(c))!
          .split(';')[0]!;
        const changed = await post(
          auth,
          '/change-password',
          { currentPassword: PASSWORD, newPassword: 'another-long-password-9' },
          { cookie: cookieOf(first) },
        );
        expect(changed.status).toBe(200);
        await flood(email);
        const stale = await httpSignIn(email, 'another-long-password-9', { cookie: old });
        expect(stale.res.status).toBe(401);
        // The same flood does not stop a browser that signs in under the new password.
        await db.delete(schema.signInFailure).where(eq(schema.signInFailure.email, email));
        const renewed = await httpSignIn(email, 'another-long-password-9');
        expect(renewed.res.status).toBe(200);
        await flood(email);
        expect(
          (await httpSignIn(email, 'another-long-password-9', { cookie: renewed.cookie! })).res
            .status,
        ).toBe(200);
      });

      it('never skips the password check', async () => {
        const email = await newUser();
        const { cookie } = await httpSignIn(email, PASSWORD);
        await flood(email);
        const wrong = await httpSignIn(email, 'wrong-password-1', { cookie: cookie! });
        expect(wrong.res.status).toBe(401);
        expect(wrong.raw).toBeUndefined();
      });

      it('keeps the per-(email, IP) cap for a known device', async () => {
        const email = await newUser();
        const { cookie } = await httpSignIn(email, PASSWORD);
        const ip = freshIp();
        await db
          .insert(schema.signInFailure)
          .values(Array.from({ length: 10 }, () => ({ email, ip })));
        const res = await httpSignIn(email, PASSWORD, { cookie: cookie!, 'x-real-ip': ip });
        expect(res.res.status).toBe(401);
      });

      it('is bound to the user: it exempts neither another account nor a forged value', async () => {
        const mine = await newUser();
        const theirs = await newUser();
        const { cookie } = await httpSignIn(mine, PASSWORD);
        await flood(theirs);
        // Another account's lockout is not lifted by my cookie, even renamed to fit.
        expect((await httpSignIn(theirs, PASSWORD, { cookie: cookie! })).res.status).toBe(401);
        const [name, value] = cookie!.split('=');
        const tampered = `${name}=${value!.slice(0, -4)}AAAA`;
        await flood(mine);
        expect((await httpSignIn(mine, PASSWORD, { cookie: tampered })).res.status).toBe(401);
      });

      it('is set for two-factor users after the second factor, not after the password', async () => {
        const email = await newUser();
        const headers = await signInHeaders(auth, email);
        const enable = await post(auth, '/two-factor/enable', { password: PASSWORD }, headers);
        const secret = new URL(
          ((await enable.json()) as { totpURI: string }).totpURI,
        ).searchParams.get('secret')!;
        await post(auth, '/two-factor/verify-totp', { code: totp(secret) }, headers);

        const first = await post(auth, '/sign-in/email', { email, password: PASSWORD });
        expect(first.headers.getSetCookie().some((c) => COOKIE.test(c))).toBe(false);
        const second = await post(
          auth,
          '/two-factor/verify-totp',
          { code: totp(secret, Date.now() + 30_000) },
          { cookie: cookieOf(first) },
        );
        expect(second.status).toBe(200);
        expect(second.headers.getSetCookie().some((c) => COOKIE.test(c))).toBe(true);
      });

      it('stops working after 180 days', async () => {
        const email = await newUser();
        const { cookie } = await httpSignIn(email, PASSWORD);
        await flood(email);
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 181 * 24 * 3600_000 });
        try {
          expect((await httpSignIn(email, PASSWORD, { cookie: cookie! })).res.status).toBe(401);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('behaves the same for an email that does not exist (no enumeration)', async () => {
      const ip = freshIp();
      for (let i = 0; i < 10; i++) await signIn('ghost@example.com', 'wrong-password-1', ip);
      const ghost = await signIn('ghost@example.com', PASSWORD, ip);
      const known = await signIn(await newUser(), 'wrong-password-1', freshIp());
      expect(ghost.status).toBe(known.status);
      expect(await ghost.json()).toEqual(await known.json());
    });

    it('is case-insensitive on the email', async () => {
      const email = await newUser();
      const ip = freshIp();
      for (let i = 0; i < 10; i++) await signIn(email, 'wrong-password-1', ip);
      expect((await signIn(email.toUpperCase(), PASSWORD, ip)).status).toBe(401);
    });

    it('lifts the lock once the failures are older than 15 minutes', async () => {
      const email = await newUser();
      const ip = freshIp();
      for (let i = 0; i < 10; i++) await signIn(email, 'wrong-password-1', ip);
      await db
        .update(schema.signInFailure)
        .set({ attemptedAt: new Date(Date.now() - 16 * 60_000) })
        .where(eq(schema.signInFailure.email, email));
      expect((await signIn(email, PASSWORD, ip)).status).toBe(200);
    });

    it("forgets that client IP's earlier failures after a successful sign-in", async () => {
      const email = await newUser();
      const ip = freshIp();
      for (let i = 0; i < 5; i++) await signIn(email, 'wrong-password-1', ip);
      expect((await signIn(email, PASSWORD, ip)).status).toBe(200);
      expect(await failures(email)).toHaveLength(0);
    });

    it('does not count a request that failed for a reason other than credentials', async () => {
      const email = await newUser();
      const ip = freshIp();
      const bad = await signIn(email, 12345 as unknown as string, ip);
      expect(bad.status).toBe(400);
      expect(await failures(email)).toHaveLength(0);
    });
  });

  describe('household and profile writes by a plain member', () => {
    it('refuses /organization/update for a member (rename, logo, slug, metadata)', async () => {
      const member = await signInHeaders(auth, 'member@example.com');
      const res = await post(
        auth,
        '/organization/update',
        {
          data: { name: 'Hijacked', logo: 'https://evil.example/x.png' },
          organizationId: householdId,
        },
        member,
      );
      expect(res.status).toBe(403);
      const [org] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, householdId));
      expect(org!.name).not.toBe('Hijacked');
    });

    it('applies the name rules (1-100 characters) to /update-user', async () => {
      const member = await signInHeaders(auth, 'member@example.com');
      const tooLong = await post(auth, '/update-user', { name: 'x'.repeat(101) }, member);
      expect(tooLong.status).toBe(400);
      const blank = await post(auth, '/update-user', { name: '   ' }, member);
      expect(blank.status).toBe(400);
      const ok = await post(auth, '/update-user', { name: '  Maria  ' }, member);
      expect(ok.status).toBe(200);
      const [row] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, 'member@example.com'));
      expect(row!.name).toBe('Maria');
    });
  });

  describe('organisation endpoints over HTTP', () => {
    // Signed in before the 2FA flag flips: afterwards sign-in would demand a second factor.
    let ownerHeaders: Record<string, string>;
    beforeAll(async () => {
      ownerHeaders = await signInHeaders(auth, 'owner@example.com');
    });

    const update = (headers: Record<string, string>) =>
      post(
        auth,
        '/organization/update',
        { data: { name: 'Casa Nova' }, organizationId: householdId },
        headers,
      );

    it('refuses owner mutations until the owner has enabled 2FA', async () => {
      const headers = ownerHeaders;
      const refused = await update(headers);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });

      // The same guard applies to server-side calls that carry the owner's session headers.
      await expect(
        auth.api.updateOrganization({
          headers: new Headers(headers),
          body: { data: { name: 'Casa Server' }, organizationId: householdId },
        }),
      ).rejects.toMatchObject({ statusCode: 403, body: { code: 'TWO_FACTOR_REQUIRED' } });

      // Reads stay available, so the owner can still load the household while enrolling.
      expect((await get(auth, '/organization/list', headers)).status).toBe(200);

      await db
        .update(schema.user)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.user.email, 'owner@example.com'));
      expect((await update(headers)).status).toBe(200);
    });

    it('lets an owner with 2FA mutate server-side too', async () => {
      const name = `Casa ${Math.random().toString(36).slice(2, 8)}`;
      await expect(
        auth.api.updateOrganization({
          headers: new Headers(ownerHeaders),
          body: { data: { name }, organizationId: householdId },
        }),
      ).resolves.toMatchObject({ name });
    });

    it('keeps invitation listings (and the full organisation, which embeds them) owner-only', async () => {
      const owner = ownerHeaders;
      const member = await signInHeaders(auth, 'member@example.com');
      const list = `/organization/list-invitations?organizationId=${householdId}`;
      const full = `/organization/get-full-organization?organizationId=${householdId}`;

      expect((await get(auth, list, member)).status).toBe(403);
      expect((await get(auth, full, member)).status).toBe(403);
      expect((await get(auth, list, owner)).status).toBe(200);
      expect((await get(auth, full, owner)).status).toBe(200);
    });
  });
});
