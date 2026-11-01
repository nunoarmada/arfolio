import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { NotFoundError, type ServiceCtx } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { createRateLimiter } from '../lib/rate-limit';
import { addMember, MCP_RESOURCE, mintOAuthToken } from '../test-mcp';
import { PASSWORD, testEnv as env } from '../test-utils';
import { createMcpRequestHandler } from './mcp-auth';
import { listConnectedApps, revokeConnectedApp } from './oauth-apps';
import { completeSetup } from './setup';

describe('connected apps', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;

  const userId = async (email: string) =>
    (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!.id;
  const ctxFor = async (email: string): Promise<ServiceCtx> => ({
    db,
    householdId,
    userId: await userId(email),
    role: 'member',
  });
  const rows = async (email: string, clientId: string) => {
    const uid = await userId(email);
    const { oauthConsent: c, oauthRefreshToken: r, oauthAccessToken: x } = schema;
    return {
      consents: await db
        .select()
        .from(c)
        .where(and(eq(c.clientId, clientId), eq(c.userId, uid))),
      refresh: await db
        .select()
        .from(r)
        .where(and(eq(r.clientId, clientId), eq(r.userId, uid))),
      access: await db
        .select()
        .from(x)
        .where(and(eq(x.clientId, clientId), eq(x.userId, uid))),
    };
  };
  // audit_log is row-level secured: read it as the household, like the app does.
  const audit = async (email: string) => {
    const uid = await userId(email);
    return withHousehold(db, householdId, (tx) =>
      tx
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.userId, uid), eq(schema.auditLog.action, 'consent.revoke'))),
    );
  };

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
    await addMember({ db, auth }, householdId, 'owner@example.com', 'a@example.com', 'member');
    await addMember({ db, auth }, householdId, 'owner@example.com', 'b@example.com', 'member');
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('lists the user’s own consents with the client name and host', async () => {
    const { clientId } = await mintOAuthToken(auth, 'a@example.com');
    const apps = await listConnectedApps(db, await userId('a@example.com'));
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      clientId,
      name: 'Claude',
      host: 'claude.ai',
    });
    expect(apps[0]!.scopes).toContain('pfm:write');
    // Nothing of someone else's.
    expect(await listConnectedApps(db, await userId('b@example.com'))).toEqual([]);
  });

  it('revokes the consent and this user’s tokens, audits it, and the token stops working', async () => {
    const minted = await mintOAuthToken(auth, 'b@example.com');
    const handler = createMcpRequestHandler({
      db,
      auth,
      env: { APP_URL: env.APP_URL, BRAND_NAME: env.BRAND_NAME },
      limiter: createRateLimiter({ max: 100, windowMs: 60_000 }),
    });
    const call = () =>
      handler(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${minted.access_token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }),
      );
    expect((await call()).status).toBe(200);
    const before = await rows('b@example.com', minted.clientId);
    expect(before.consents).toHaveLength(1);
    expect(before.refresh.length).toBeGreaterThan(0);

    await revokeConnectedApp(await ctxFor('b@example.com'), minted.clientId);

    const after = await rows('b@example.com', minted.clientId);
    expect(after.consents).toHaveLength(0);
    expect(after.refresh).toHaveLength(0);
    expect(after.access).toHaveLength(0);
    expect((await call()).status).toBe(401);
    const [entry] = await audit('b@example.com');
    expect(entry).toMatchObject({
      householdId,
      actor: 'web',
      targetType: 'oauth_client',
      targetId: minted.clientId,
      credential: `oauth:${minted.clientId}`,
    });
    expect(await listConnectedApps(db, await userId('b@example.com'))).toEqual([]);
  });

  it('leaves other apps and other users alone', async () => {
    const a = await mintOAuthToken(auth, 'a@example.com');
    const b = await mintOAuthToken(auth, 'b@example.com');
    await revokeConnectedApp(await ctxFor('a@example.com'), a.clientId);
    expect((await rows('a@example.com', a.clientId)).consents).toHaveLength(0);
    expect((await rows('b@example.com', b.clientId)).consents).toHaveLength(1);
    // The first app of user a (from the first test) is still connected.
    expect(await listConnectedApps(db, await userId('a@example.com'))).toHaveLength(1);
    // Not someone else's: user a cannot revoke user b's grant.
    await expect(revokeConnectedApp(await ctxFor('a@example.com'), b.clientId)).rejects.toThrow(
      NotFoundError,
    );
    expect((await rows('b@example.com', b.clientId)).consents).toHaveLength(1);
  });

  it('says "not found" for an unknown client and writes no audit row', async () => {
    const count = (await audit('a@example.com')).length;
    await expect(revokeConnectedApp(await ctxFor('a@example.com'), 'nope')).rejects.toThrow(
      NotFoundError,
    );
    expect((await audit('a@example.com')).length).toBe(count);
  });
});
