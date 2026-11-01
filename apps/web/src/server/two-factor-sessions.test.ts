import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { cookieOf, PASSWORD, post, signInHeaders, testEnv as env } from '../test-utils';
import { completeSetup } from './setup';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret, as the authenticator app would. */
function totp(secretBase32: string): string {
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, ''))
    bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

describe('enabling two-factor revokes the other sessions', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 8 });
    db = app.db;
    close = () => app.pool.end();
    auth = createAuth({ db, env });
    await completeSetup(
      {
        token: env.SETUP_TOKEN,
        name: 'Owner',
        email: 'owner@example.com',
        password: PASSWORD,
        householdName: 'Home',
        locale: 'en',
      },
      { db, auth, env },
    );
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  const sessionCount = async (email: string): Promise<number> => {
    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    const rows = await db.select().from(schema.session).where(eq(schema.session.userId, user!.id));
    return rows.length;
  };

  it('keeps the current session and drops every other one once the TOTP is verified', async () => {
    const stale = await signInHeaders(auth, 'owner@example.com');
    const current = await signInHeaders(auth, 'owner@example.com');
    expect(await sessionCount('owner@example.com')).toBeGreaterThanOrEqual(2);

    const enable = await post(auth, '/two-factor/enable', { password: PASSWORD }, current);
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get('secret')!;

    const verify = await post(auth, '/two-factor/verify-totp', { code: totp(secret) }, current);
    expect(verify.status).toBe(200);

    const fresh = { cookie: cookieOf(verify) };
    expect(await sessionCount('owner@example.com')).toBe(1);
    const stillValid = await auth.api.getSession({ headers: new Headers(fresh) });
    expect(stillValid?.user.twoFactorEnabled).toBe(true);
    const revoked = await auth.api.getSession({ headers: new Headers(stale) });
    expect(revoked).toBeNull();
  });

  it('leaves other sessions alone when the code is wrong', async () => {
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.user.email, 'owner@example.com'));
    await db.delete(schema.twoFactor);
    const other = await signInHeaders(auth, 'owner@example.com');
    const current = await signInHeaders(auth, 'owner@example.com');
    expect((await post(auth, '/two-factor/enable', { password: PASSWORD }, current)).status).toBe(
      200,
    );

    const verify = await post(auth, '/two-factor/verify-totp', { code: '000000' }, current);
    expect(verify.status).toBe(401);
    expect(await auth.api.getSession({ headers: new Headers(other) })).not.toBeNull();
  });
});
