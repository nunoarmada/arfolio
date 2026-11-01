import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { createAccount, createPat, type PatScope, type ServiceCtx } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { createRateLimiter } from '../lib/rate-limit';
import { addMember, jwtPayload, MCP_RESOURCE, mintOAuthToken, tokenRequest } from '../test-mcp';
import { BASE_URL, cookieOf, PASSWORD, post, testEnv as env } from '../test-utils';
import { createMcpRequestHandler } from './mcp-auth';
import { completeSetup } from './setup';

const METADATA = `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`;
const CHALLENGE = `Bearer resource_metadata="${METADATA}"`;

type Handler = (req: Request) => Promise<Response>;

describe('/api/mcp endpoint', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;
  let handler: Handler;
  let ownerCtx: ServiceCtx;
  let accountId: string;

  const userId = async (email: string) =>
    (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!.id;
  const ctxFor = async (email: string, role: ServiceCtx['role']): Promise<ServiceCtx> => ({
    db,
    householdId,
    userId: await userId(email),
    role,
  });
  const setRole = async (email: string, role: string) =>
    db
      .update(schema.member)
      .set({ role })
      .where(eq(schema.member.userId, await userId(email)));
  const patFor = async (email: string, role: ServiceCtx['role'], scope: PatScope) =>
    (await createPat(await ctxFor(email, role), { name: 'test', scope, expiresInDays: 30 })).token;

  const rpcBody = (method: string, params: unknown = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  });
  const rpc = (h: Handler, token: string | null, method: string, params?: unknown) =>
    h(
      new Request(MCP_RESOURCE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(rpcBody(method, params)),
      }),
    );
  /** The JSON-RPC result of a response, whether it came as plain JSON or as one SSE message. */
  const rpcResult = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    const data = res.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
      : text;
    return (JSON.parse(data) as { result: unknown }).result;
  };
  const callTool = async (h: Handler, token: string, name: string, args: unknown = {}) => {
    const res = await rpc(h, token, 'tools/call', { name, arguments: args });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await rpcResult(res)) as { isError?: boolean; structuredContent?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const clientFor = async (h: Handler, token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), {
      fetch: (input, init) => h(new Request(input, init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    return client;
  };
  const makeHandler = (max = 120): Handler =>
    createMcpRequestHandler({
      db,
      auth,
      env: { APP_URL: env.APP_URL, BRAND_NAME: env.BRAND_NAME },
      limiter: createRateLimiter({ max, windowMs: 60_000 }),
    });

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
    for (const [email, role] of [
      ['member@example.com', 'member'],
      ['member2@example.com', 'member'],
      ['member3@example.com', 'member'],
      ['viewer@example.com', 'viewer'],
      ['dropped@example.com', 'member'],
      ['grantee@example.com', 'member'],
    ] as const)
      await addMember({ db, auth }, householdId, 'owner@example.com', email, role);
    ownerCtx = await ctxFor('owner@example.com', 'owner');
    accountId = (await createAccount(ownerCtx, { name: 'Conta', type: 'checking' })).id;
    handler = makeHandler();
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  describe('personal access tokens', () => {
    beforeAll(async () => {
      // Owners need two-factor to use the API; most of these tests use members.
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: true })
        .where(eq(schema.user.email, 'owner@example.com'));
    });

    it('lists tools and calls one through the SDK client', async () => {
      const client = await clientFor(handler, await patFor('member@example.com', 'member', 'read'));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['list_accounts', 'create_manual_transaction']),
      );
      const res = (await client.callTool({ name: 'list_accounts', arguments: {} })) as {
        structuredContent: { accounts: Array<{ id: string }> };
      };
      expect(res.structuredContent.accounts.map((a) => a.id)).toEqual([accountId]);
      await client.close();
    });

    it('answers every response with Cache-Control: no-store', async () => {
      const token = await patFor('member@example.com', 'member', 'read');
      expect((await rpc(handler, token, 'tools/list')).headers.get('cache-control')).toBe(
        'no-store',
      );
      expect((await rpc(handler, null, 'tools/list')).headers.get('cache-control')).toBe(
        'no-store',
      );
    });

    it('401 with the resource metadata challenge for a missing, malformed, unknown or revoked token', async () => {
      for (const token of [null, 'pfm_pat_nope', 'garbage']) {
        const res = await rpc(handler, token, 'tools/list');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
      }
      const bad = await handler(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(bad.status).toBe(401);
      expect(bad.headers.get('www-authenticate')).toBe(CHALLENGE);

      const ctx = await ctxFor('member@example.com', 'member');
      const { token, pat } = await createPat(ctx, {
        name: 'revoked',
        scope: 'read',
        expiresInDays: 30,
      });
      expect((await rpc(handler, token, 'tools/list')).status).toBe(200);
      const { revokePat } = await import('@arfolio/services');
      await revokePat(ctx, pat.id);
      expect((await rpc(handler, token, 'tools/list')).status).toBe(401);
    });

    it('does not accept a session cookie as a credential', async () => {
      const signIn = await post(auth, '/sign-in/email', {
        email: 'member@example.com',
        password: PASSWORD,
      });
      const res = await handler(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: {
            cookie: cookieOf(signIn),
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(rpcBody('tools/list')),
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it('a read PAT calling a write tool gets a tool error and nothing is written', async () => {
      const token = await patFor('member2@example.com', 'member', 'read');
      const result = await callTool(handler, token, 'create_manual_transaction', {
        account_id: accountId,
        booking_date: '2026-01-02',
        amount: '-1.00',
        description: 'blocked',
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe('insufficient_scope');
      const found = await callTool(handler, token, 'search_transactions', { query: 'blocked' });
      expect(JSON.stringify(found.structuredContent)).not.toContain('blocked');
    });

    it('a read_write PAT writes; a demotion to viewer blocks the next write', async () => {
      const token = await patFor('member3@example.com', 'member', 'read_write');
      const args = {
        account_id: accountId,
        booking_date: '2026-01-02',
        amount: '-2.50',
        description: 'before demotion',
      };
      const first = await callTool(handler, token, 'create_manual_transaction', args);
      expect(first.isError).toBeFalsy();

      await setRole('member3@example.com', 'viewer');
      try {
        const second = await callTool(handler, token, 'create_manual_transaction', {
          ...args,
          description: 'after demotion',
        });
        expect(second.isError).toBe(true);
        expect(['forbidden', 'insufficient_scope']).toContain(second.structuredContent.error.code);
        const found = await callTool(handler, token, 'search_transactions', {
          query: 'demotion',
        });
        expect(JSON.stringify(found.structuredContent)).not.toContain('after demotion');
        expect(JSON.stringify(found.structuredContent)).toContain('before demotion');
      } finally {
        await setRole('member3@example.com', 'member');
      }
    });

    it('a removed member loses access on the next request', async () => {
      const token = await patFor('dropped@example.com', 'member', 'read');
      expect((await rpc(handler, token, 'tools/list')).status).toBe(200);
      await db
        .delete(schema.member)
        .where(eq(schema.member.userId, await userId('dropped@example.com')));
      const res = await rpc(handler, token, 'tools/list');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it('refuses a forged household argument and never crosses households', async () => {
      const token = await patFor('member@example.com', 'member', 'read');
      const forged = await callTool(handler, token, 'list_accounts', {
        householdId: randomUUID(),
      });
      // Rejected by the SDK's input validation: the tools take no household argument at all.
      expect(forged.isError).toBe(true);
      expect(forged.structuredContent?.accounts).toBeUndefined();

      // A second household with its own member, account and PAT.
      const owner = createDb(testDb.ownerUrl, { max: 2 });
      try {
        await owner.db.insert(schema.organization).values({
          id: 'house-b',
          name: 'B',
          slug: 'house-b',
          createdAt: new Date(),
        });
        await owner.db
          .insert(schema.user)
          .values({ id: 'user-b', name: 'B', email: 'b@example.com' });
        await owner.db.insert(schema.member).values({
          id: 'member-b',
          organizationId: 'house-b',
          userId: 'user-b',
          role: 'member',
          createdAt: new Date(),
        });
      } finally {
        await owner.pool.end();
      }
      const ctxB: ServiceCtx = { db, householdId: 'house-b', userId: 'user-b', role: 'member' };
      const accountB = (await createAccount(ctxB, { name: 'Conta B', type: 'checking' })).id;
      const { token: tokenB } = await createPat(ctxB, {
        name: 'b',
        scope: 'read_write',
        expiresInDays: null,
      });
      const seenByB = await callTool(handler, tokenB, 'list_accounts');
      expect(seenByB.structuredContent.accounts.map((a: { id: string }) => a.id)).toEqual([
        accountB,
      ]);
      const write = await callTool(handler, tokenB, 'create_manual_transaction', {
        account_id: accountId,
        booking_date: '2026-01-02',
        amount: '-1.00',
        description: 'cross',
      });
      expect(write.isError).toBe(true);
      expect(write.structuredContent.error.code).toBe('not_found');
    });

    it('refuses an owner without two-factor, for a PAT too', async () => {
      const token = await patFor('owner@example.com', 'owner', 'read');
      expect((await rpc(handler, token, 'tools/list')).status).toBe(200);
      await db
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.email, 'owner@example.com'));
      try {
        const res = await rpc(handler, token, 'tools/list');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'two_factor_required' });
      } finally {
        await db
          .update(schema.user)
          .set({ twoFactorEnabled: true })
          .where(eq(schema.user.email, 'owner@example.com'));
      }
    });

    it('rejects a JSON-RPC batch with 400, so one request cannot carry many calls past the limit', async () => {
      const token = await patFor('member@example.com', 'member', 'read');
      const res = await handler(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify([rpcBody('tools/list'), { ...rpcBody('tools/list'), id: 2 }]),
        }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Batch requests are not supported' },
        id: null,
      });
      // A single request still reaches the SDK after the body was inspected.
      expect((await rpc(handler, token, 'tools/list')).status).toBe(200);
    });

    it('answers 429 with a JSON-RPC error over the limit, per token', async () => {
      const limited = makeHandler(3);
      const token = await patFor('member@example.com', 'member', 'read');
      const other = await patFor('member2@example.com', 'member', 'read');
      for (let i = 0; i < 3; i++)
        expect((await rpc(limited, token, 'tools/list')).status).toBe(200);
      const res = await rpc(limited, token, 'tools/list');
      expect(res.status).toBe(429);
      const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
      expect(body.jsonrpc).toBe('2.0');
      expect(typeof body.error.code).toBe('number');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect((await rpc(limited, other, 'tools/list')).status).toBe(200);
    });
  });

  describe('oauth access tokens', () => {
    it('lists tools and calls one with a token minted by the real flow', async () => {
      const { access_token } = await mintOAuthToken(auth, 'member@example.com');
      const client = await clientFor(handler, access_token);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const res = (await client.callTool({ name: 'list_accounts', arguments: {} })) as {
        structuredContent: { accounts: Array<{ id: string }> };
      };
      expect(res.structuredContent.accounts.map((a) => a.id)).toEqual([accountId]);
      await client.close();
    });

    it('401 + challenge for an opaque token, a wrong audience and a tampered token', async () => {
      for (const token of ['opaque-token-value', 'a.b.c']) {
        const res = await rpc(handler, token, 'tools/list');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
      }
      const other = await mintOAuthToken(auth, 'member@example.com', {
        resource: `${BASE_URL}/api/other`,
      }).catch(() => null);
      // The authorization server only binds the registered resource; where it does issue a token
      // for another one, the audience check must refuse it.
      if (other) expect((await rpc(handler, other.access_token, 'tools/list')).status).toBe(401);
      const { access_token } = await mintOAuthToken(auth, 'member@example.com');
      const [h, p, s] = access_token.split('.');
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
      claims.aud = `${BASE_URL}/api/other`;
      const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
      const res = await rpc(handler, forged, 'tools/list');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it('rejects a token whose audience is not this resource (handler for another APP_URL)', async () => {
      const { access_token } = await mintOAuthToken(auth, 'member@example.com');
      const elsewhere = createMcpRequestHandler({
        db,
        auth,
        env: { APP_URL: 'http://localhost:4000', BRAND_NAME: 'X' },
        limiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
      });
      const res = await rpc(elsewhere, access_token, 'tools/list');
      expect(res.status).toBe(401);
    });

    it('re-reads the role: a demoted member loses write on the next call, a removed one all access', async () => {
      const { access_token } = await mintOAuthToken(auth, 'member2@example.com');
      const args = {
        account_id: accountId,
        booking_date: '2026-01-03',
        amount: '-4.00',
        description: 'oauth write',
      };
      const first = await callTool(handler, access_token, 'create_manual_transaction', args);
      expect(first.isError).toBeFalsy();

      await setRole('member2@example.com', 'viewer');
      const second = await callTool(handler, access_token, 'create_manual_transaction', {
        ...args,
        description: 'oauth write after demotion',
      });
      expect(second.isError).toBe(true);
      expect(['forbidden', 'insufficient_scope']).toContain(second.structuredContent.error.code);
      const found = await callTool(handler, access_token, 'search_transactions', {
        query: 'after demotion',
      });
      expect(JSON.stringify(found.structuredContent)).not.toContain('oauth write after demotion');

      const userRow = await userId('member2@example.com');
      await db.delete(schema.member).where(eq(schema.member.userId, userRow));
      // Removing the member also ended their OAuth grants (trigger), so the token is simply dead.
      const gone = await rpc(handler, access_token, 'tools/list');
      expect(gone.status).toBe(401);
      await db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: householdId,
        userId: userRow,
        role: 'member',
        createdAt: new Date(),
      });
    });

    it('a removed member loses OAuth grants for good: re-adding them revives neither token', async () => {
      const minted = await mintOAuthToken(auth, 'grantee@example.com');
      const refreshToken = (minted as unknown as { refresh_token: string }).refresh_token;
      expect(refreshToken).toBeTruthy();
      expect((await rpc(handler, minted.access_token, 'tools/list')).status).toBe(200);

      const userRow = await userId('grantee@example.com');
      await db.delete(schema.member).where(eq(schema.member.userId, userRow));
      expect((await rpc(handler, minted.access_token, 'tools/list')).status).toBe(401);
      for (const table of [schema.oauthConsent, schema.oauthRefreshToken, schema.oauthAccessToken])
        expect(await db.select().from(table).where(eq(table.userId, userRow))).toEqual([]);

      await db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: householdId,
        userId: userRow,
        role: 'member',
        createdAt: new Date(),
      });
      expect((await rpc(handler, minted.access_token, 'tools/list')).status).toBe(401);
      const refreshed = await tokenRequest(auth, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: minted.clientId,
        resource: MCP_RESOURCE,
      });
      expect(refreshed.status).toBeGreaterThanOrEqual(400);
      expect(refreshed.status).toBeLessThan(500);
      expect(await refreshed.text()).not.toContain('access_token');
    });

    it('answers 403 two_factor_required for an owner without two-factor', async () => {
      // Two-factor owners cannot sign in with a password alone, so the token is minted as a member
      // who is then made an owner (no two-factor set up).
      const { access_token } = await mintOAuthToken(auth, 'member@example.com');
      await setRole('member@example.com', 'owner');
      try {
        const res = await rpc(handler, access_token, 'tools/list');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'two_factor_required' });
      } finally {
        await setRole('member@example.com', 'member');
      }
    });

    it('stops working once the consent is revoked', async () => {
      const { access_token, clientId } = await mintOAuthToken(auth, 'viewer@example.com');
      expect((await rpc(handler, access_token, 'tools/list')).status).toBe(200);
      await db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.clientId, clientId));
      const res = await rpc(handler, access_token, 'tools/list');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it('does not come back when the app is revoked and then connected again', async () => {
      const { access_token, clientId } = await mintOAuthToken(auth, 'viewer@example.com');
      const { iat } = jwtPayload(access_token) as { iat: number };
      // Revoke and re-consent: the consent row is recreated after the token was issued.
      await db
        .update(schema.oauthConsent)
        .set({ createdAt: new Date((iat + 5) * 1000) })
        .where(eq(schema.oauthConsent.clientId, clientId));
      const res = await rpc(handler, access_token, 'tools/list');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it('stops working when the client is disabled', async () => {
      const { access_token, clientId } = await mintOAuthToken(auth, 'viewer@example.com');
      await db
        .update(schema.oauthClient)
        .set({ disabled: true })
        .where(eq(schema.oauthClient.clientId, clientId));
      expect((await rpc(handler, access_token, 'tools/list')).status).toBe(401);
    });

    it('401 for an expired access token, and for an expired PAT', async () => {
      const { access_token } = await mintOAuthToken(auth, 'viewer@example.com');
      const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
      const future = createMcpRequestHandler({
        db,
        auth,
        env: { APP_URL: env.APP_URL, BRAND_NAME: env.BRAND_NAME },
        limiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
        now: later,
      });
      expect((await rpc(handler, access_token, 'tools/list')).status).toBe(200);
      const expired = await rpc(future, access_token, 'tools/list');
      expect(expired.status).toBe(401);
      expect(expired.headers.get('www-authenticate')).toBe(CHALLENGE);

      const ctx = await ctxFor('viewer@example.com', 'viewer');
      const { token } = await createPat(ctx, { name: 'short', scope: 'read', expiresInDays: 30 });
      expect((await rpc(handler, token, 'tools/list')).status).toBe(200);
      const farFuture = createMcpRequestHandler({
        db,
        auth,
        env: { APP_URL: env.APP_URL, BRAND_NAME: env.BRAND_NAME },
        limiter: createRateLimiter({ max: 10, windowMs: 60_000 }),
        now: () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      });
      expect((await rpc(farFuture, token, 'tools/list')).status).toBe(401);
    });

    it('403 household_unresolved for a user with more than one household', async () => {
      const { access_token } = await mintOAuthToken(auth, 'viewer@example.com');
      const owner = createDb(testDb.ownerUrl, { max: 2 });
      try {
        await owner.db.insert(schema.organization).values({
          id: 'house-c',
          name: 'C',
          slug: 'house-c',
          createdAt: new Date(),
        });
        await owner.db.insert(schema.member).values({
          id: 'member-c',
          organizationId: 'house-c',
          userId: await userId('viewer@example.com'),
          role: 'viewer',
          createdAt: new Date(),
        });
        const res = await rpc(handler, access_token, 'tools/list');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'household_unresolved' });
      } finally {
        await owner.db.delete(schema.organization).where(eq(schema.organization.id, 'house-c'));
        await owner.pool.end();
      }
    });

    it('rate limits an oauth caller per user and client', async () => {
      const limited = makeHandler(2);
      const { access_token } = await mintOAuthToken(auth, 'viewer@example.com');
      expect((await rpc(limited, access_token, 'tools/list')).status).toBe(200);
      expect((await rpc(limited, access_token, 'tools/list')).status).toBe(200);
      expect((await rpc(limited, access_token, 'tools/list')).status).toBe(429);
    });
  });

  it('answers an unexpected failure with a bare JSON-RPC internal error', async () => {
    const token = await patFor('member@example.com', 'member', 'read');
    const broken = createMcpRequestHandler({
      db,
      auth,
      env: { APP_URL: env.APP_URL, BRAND_NAME: env.BRAND_NAME },
      limiter: {
        take: () => {
          throw new Error('secret detail');
        },
      },
    });
    const res = await rpc(broken, token, 'tools/list');
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('secret detail');
    expect(JSON.parse(text).error.code).toBe(-32603);
  });

  it('only the SDK stateless methods are served', async () => {
    const token = await patFor('member@example.com', 'member', 'read');
    const res = await handler(
      new Request(MCP_RESOURCE, { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(405);
  });
});
