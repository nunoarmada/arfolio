import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { requireMcpAuth } from '@better-auth/mcp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import {
  BASE_URL,
  cookieOf,
  freshIp,
  get,
  PASSWORD,
  post,
  signInHeaders,
  testEnv as env,
} from '../test-utils';
import {
  addMember as addTestMember,
  authorizeAndConsent as authorizeAndConsentFor,
  authorizeUrl,
  CLAUDE_CALLBACK,
  jwtPayload,
  MCP_RESOURCE as RESOURCE,
  MCP_TEST_SCOPES as SCOPES,
  pkce,
  registerClaude as registerClaudeFor,
  registerClient,
  tokenRequest,
} from '../test-mcp';
import { completeSetup } from './setup';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret, as an authenticator app would. */
function totp(secretBase32: string): string {
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, ''))
    bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

describe('mcp oauth 2.1 authorization server', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;

  const rootUrl = (path: string) => `${BASE_URL}${path}`;

  const addMember = (email: string, role: string) =>
    addTestMember({ db, auth }, householdId, 'owner@example.com', email, role);
  const register = (redirectUris: string[], headers: Record<string, string> = {}) =>
    registerClient(auth, redirectUris, headers);
  const registerClaude = () => registerClaudeFor(auth);
  const authorizeAndConsent = (
    headers: Record<string, string>,
    clientId: string,
    challenge: string,
    consent?: { accept: boolean; scope?: string },
  ) => authorizeAndConsentFor(auth, headers, clientId, challenge, consent);
  const token = (params: Record<string, string>) => tokenRequest(auth, params);

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
    await addMember('viewer@example.com', 'viewer');
    await addMember('twofa@example.com', 'member');
    await addMember('member2@example.com', 'member');
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  describe('full flow', () => {
    it('registers, authorizes with PKCE, consents, exchanges, and rotates the refresh token', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member@example.com');
      const { verifier, challenge } = pkce();

      const callback = await authorizeAndConsent(member, clientId, challenge);
      expect(`${callback.origin}${callback.pathname}`).toBe(CLAUDE_CALLBACK);
      expect(callback.searchParams.get('state')).toBe('xyz');
      const code = callback.searchParams.get('code')!;
      expect(code).toBeTruthy();

      const exchanged = await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });
      expect(exchanged.status, await exchanged.clone().text()).toBe(200);
      const tokens = (await exchanged.json()) as {
        access_token: string;
        refresh_token: string;
        scope: string;
        expires_in: number;
      };
      const claims = jwtPayload(tokens.access_token);
      // The openid scope also adds the userinfo endpoint as an audience; the MCP resource is one.
      expect([claims.aud].flat()).toContain(RESOURCE);
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope.split(' ')).toEqual(
        expect.arrayContaining(['pfm:read', 'pfm:write', 'offline_access']),
      );
      expect(tokens.refresh_token).toBeTruthy();

      const refreshed = await token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: RESOURCE,
      });
      expect(refreshed.status, await refreshed.clone().text()).toBe(200);
      const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect([jwtPayload(next.access_token).aud].flat()).toContain(RESOURCE);
    });

    it('grants a viewer pfm:read only, even when write was requested and posted', async () => {
      const clientId = await registerClaude();
      const viewer = await signInHeaders(auth, 'viewer@example.com');
      const { verifier, challenge } = pkce();
      const callback = await authorizeAndConsent(viewer, clientId, challenge, {
        accept: true,
        scope: SCOPES,
      });
      const exchanged = await token({
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });
      expect(exchanged.status, await exchanged.clone().text()).toBe(200);
      const tokens = (await exchanged.json()) as { scope: string; access_token: string };
      const scopes = tokens.scope.split(' ');
      expect(scopes).toContain('pfm:read');
      expect(scopes).not.toContain('pfm:write');
      expect(String(jwtPayload(tokens.access_token).scope).split(' ')).not.toContain('pfm:write');
    });

    it('refuses consent from a user without exactly one household', async () => {
      const [owner] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, 'member@example.com'));
      await db.delete(schema.member).where(eq(schema.member.userId, owner!.id));
      const clientId = await registerClaude();
      const headers = await signInHeaders(auth, 'member@example.com');
      const { challenge } = pkce();
      const authz = await get(auth, authorizeUrl(clientId, challenge), headers);
      const consentUrl = new URL(authz.headers.get('location')!, BASE_URL);
      const res = await post(
        auth,
        '/oauth2/consent',
        { accept: true, oauth_query: consentUrl.search.slice(1) },
        headers,
      );
      expect(res.status).toBe(403);
    });

    it('returns an access_denied redirect when the user denies', async () => {
      const clientId = await registerClaude();
      const owner = await signInHeaders(auth, 'owner@example.com');
      const { challenge } = pkce();
      const callback = await authorizeAndConsent(owner, clientId, challenge, { accept: false });
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('code')).toBeNull();
    });
  });

  describe('sign-in continuation', () => {
    /** The signed query the provider puts on the sign-in page URL for an anonymous authorize. */
    async function signInQuery(): Promise<string> {
      const clientId = await registerClaude();
      const res = await get(auth, authorizeUrl(clientId, pkce().challenge));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!, BASE_URL);
      expect(location.pathname).toBe('/sign-in');
      expect(location.searchParams.has('sig')).toBe(true);
      return location.search.slice(1);
    }

    it('continues to the consent page after a password sign-in that carries the signed query', async () => {
      const res = await post(auth, '/sign-in/email', {
        email: 'member@example.com',
        password: PASSWORD,
        oauth_query: await signInQuery(),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { redirect?: boolean; url?: string };
      expect(body.redirect).toBe(true);
      expect(new URL(body.url!, BASE_URL).pathname).toBe('/oauth/consent');
    });

    it('leaves an ordinary sign-in untouched', async () => {
      const res = await post(auth, '/sign-in/email', {
        email: 'member@example.com',
        password: PASSWORD,
      });
      const body = (await res.json()) as { redirect?: boolean; url?: string };
      expect(res.status).toBe(200);
      expect(body.redirect).toBe(false);
    });

    it('continues after the TOTP step when the signed query is carried along', async () => {
      const headers = await signInHeaders(auth, 'twofa@example.com');
      const enable = await post(auth, '/two-factor/enable', { password: PASSWORD }, headers);
      const { totpURI } = (await enable.json()) as { totpURI: string };
      const secret = new URL(totpURI).searchParams.get('secret')!;
      expect(
        (await post(auth, '/two-factor/verify-totp', { code: totp(secret) }, headers)).status,
      ).toBe(200);

      const oauthQuery = await signInQuery();
      const signIn = await post(auth, '/sign-in/email', {
        email: 'twofa@example.com',
        password: PASSWORD,
        oauth_query: oauthQuery,
      });
      expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
        true,
      );

      const verify = await post(
        auth,
        '/two-factor/verify-totp',
        { code: totp(secret), oauth_query: oauthQuery },
        { cookie: cookieOf(signIn) },
      );
      expect(verify.status, await verify.clone().text()).toBe(200);
      const body = (await verify.json()) as { redirect?: boolean; url?: string };
      expect(body.redirect).toBe(true);
      expect(new URL(body.url!, BASE_URL).pathname).toBe('/oauth/consent');
    });
  });

  describe('resource server verification', () => {
    it('requireMcpAuth accepts the issued JWT, and challenges requests without one', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member2@example.com');
      const { verifier, challenge } = pkce();
      const callback = await authorizeAndConsent(member, clientId, challenge);
      const exchanged = await token({
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code')!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });
      const { access_token } = (await exchanged.json()) as { access_token: string };

      // requireMcpAuth fetches the JWKS over HTTP; serve that from the in-process instance.
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new Request(input, init).url;
        return url.startsWith(`${BASE_URL}/api/auth/`)
          ? auth.handler(new Request(url))
          : realFetch(input, init);
      });
      try {
        const guarded = requireMcpAuth(
          auth,
          (_req, claims) => Response.json({ sub: claims.sub, scope: claims.scope }),
          { resource: RESOURCE, requiredScopes: ['pfm:read'] },
        );
        const ok = await guarded(
          new Request(RESOURCE, { headers: { authorization: `Bearer ${access_token}` } }),
        );
        expect(ok.status, await ok.clone().text()).toBe(200);
        expect(((await ok.json()) as { sub: string }).sub).toBeTruthy();

        const anon = await guarded(new Request(RESOURCE));
        expect(anon.status).toBe(401);
        expect(anon.headers.get('www-authenticate')).toContain(
          `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp`,
        );

        const otherResource = requireMcpAuth(auth, () => Response.json({}), {
          resource: `${BASE_URL}/api/other`,
        });
        const wrongAudience = await otherResource(
          new Request(RESOURCE, { headers: { authorization: `Bearer ${access_token}` } }),
        );
        expect(wrongAudience.status).toBe(401);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('hardening', () => {
    it('rejects registration with a redirect URI outside the allowlist', async () => {
      const res = await register(['https://evil.example/cb']);
      expect(res.status).toBe(400);
      const bad = await register([CLAUDE_CALLBACK, 'https://evil.example/cb']);
      expect(bad.status).toBe(400);
    });

    it('accepts claude.com and loopback callbacks, on any port', async () => {
      for (const uri of [
        'https://claude.com/api/mcp/auth_callback',
        'http://localhost:53124/callback',
        'http://127.0.0.1:8123/callback',
      ]) {
        const res = await register([uri]);
        expect(res.status, `${uri}: ${await res.clone().text()}`).toBe(201);
      }
    });

    it('rejects loopback callbacks on other paths and look-alike hosts', async () => {
      for (const uri of [
        'http://localhost:53124/other',
        'http://localhost.evil.example/callback',
        'https://claude.ai.evil.example/api/mcp/auth_callback',
        'http://claude.ai/api/mcp/auth_callback',
      ]) {
        expect((await register([uri])).status, uri).toBe(400);
      }
    });

    it('rejects an authorization request without PKCE', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member2@example.com');
      const res = await get(auth, authorizeUrl(clientId, null), member);
      expect(res.status).toBe(302);
      const redirected = new URL(res.headers.get('location')!);
      expect(`${redirected.origin}${redirected.pathname}`).toBe(CLAUDE_CALLBACK);
      expect(redirected.searchParams.get('error')).toBe('invalid_request');
      expect(redirected.searchParams.get('error_description')).toBe(
        'pkce is required for public clients',
      );
      expect(redirected.searchParams.get('code')).toBeNull();
    });

    it('refuses an owner without two-factor at consent, but lets them deny', async () => {
      const clientId = await registerClaude();
      const owner = await signInHeaders(auth, 'owner@example.com');
      const authz = await get(auth, authorizeUrl(clientId, pkce().challenge), owner);
      const oauthQuery = new URL(authz.headers.get('location')!, BASE_URL).search.slice(1);
      const allow = await post(
        auth,
        '/oauth2/consent',
        { accept: true, oauth_query: oauthQuery },
        owner,
      );
      expect(allow.status).toBe(403);
      expect(((await allow.json()) as { code?: string }).code).toBe('TWO_FACTOR_REQUIRED');
      const deny = await post(
        auth,
        '/oauth2/consent',
        { accept: false, oauth_query: oauthQuery },
        owner,
      );
      expect(deny.status).toBe(200);
    });

    it('refuses consent from a session older than 10 minutes, but lets them deny', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member2@example.com');
      const authz = await get(auth, authorizeUrl(clientId, pkce().challenge), member);
      const oauthQuery = new URL(authz.headers.get('location')!, BASE_URL).search.slice(1);
      const [user] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, 'member2@example.com'));
      await db
        .update(schema.session)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(schema.session.userId, user!.id));

      const allow = await post(
        auth,
        '/oauth2/consent',
        { accept: true, oauth_query: oauthQuery },
        member,
      );
      expect(allow.status).toBe(403);
      expect(((await allow.json()) as { code?: string }).code).toBe('SESSION_NOT_FRESH');
      const deny = await post(
        auth,
        '/oauth2/consent',
        { accept: false, oauth_query: oauthQuery },
        member,
      );
      expect(deny.status).toBe(200);
    });

    it('sends a stale session to the consent page even when consent was stored', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member2@example.com');
      // First authorisation stores the consent.
      await authorizeAndConsent(member, clientId, pkce().challenge);
      // With a fresh session the stored consent is honoured: straight to the client's callback.
      const again = await get(auth, authorizeUrl(clientId, pkce().challenge), member);
      expect(new URL(again.headers.get('location')!, BASE_URL).pathname).toBe(
        new URL(CLAUDE_CALLBACK).pathname,
      );

      const [user] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, 'member2@example.com'));
      await db
        .update(schema.session)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(schema.session.userId, user!.id));
      const stale = await get(auth, authorizeUrl(clientId, pkce().challenge), member);
      const location = new URL(stale.headers.get('location')!, BASE_URL);
      expect(location.pathname).toBe('/oauth/consent');
      expect(location.searchParams.get('code')).toBeNull();
    });

    it('has no /oauth2/continue, which could issue a code from a stored consent', async () => {
      const clientId = await registerClaude();
      const member = await signInHeaders(auth, 'member2@example.com');
      await authorizeAndConsent(member, clientId, pkce().challenge);
      const authz = await get(auth, authorizeUrl(clientId, pkce().challenge), member);
      const oauthQuery = new URL(authz.headers.get('location')!, BASE_URL).search.slice(1);
      for (const body of [{ selected: true }, { created: true }, { postLogin: true }]) {
        const res = await post(
          auth,
          '/oauth2/continue',
          { ...body, oauth_query: oauthQuery },
          member,
        );
        expect(res.status).toBe(404);
      }
    });

    it('does not let a signed-in member use the client management endpoints', async () => {
      const member = await signInHeaders(auth, 'member2@example.com');
      const res = await post(
        auth,
        '/oauth2/create-client',
        {
          client_name: 'Mine',
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: 'none',
        },
        member,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const clients = await db.select().from(schema.oauthClient);
      expect(clients.some((c) => c.name === 'Mine')).toBe(false);
    });

    it('refuses at authorize time a client whose stored redirect URI is not allowlisted', async () => {
      const evil = 'https://evil.example/cb';
      await db.insert(schema.oauthClient).values({
        id: 'evil-row',
        clientId: 'evil-client',
        name: 'Evil',
        redirectUris: [evil],
        tokenEndpointAuthMethod: 'none',
        grantTypes: ['authorization_code'],
        responseTypes: ['code'],
        scopes: ['pfm:read'],
        requirePKCE: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const member = await signInHeaders(auth, 'member2@example.com');
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: 'evil-client',
        redirect_uri: evil,
        scope: 'pfm:read',
        state: 'xyz',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        resource: RESOURCE,
      });
      const res = await get(auth, `/oauth2/authorize?${q}`, member);
      const location = res.headers.get('location');
      expect(res.status).toBe(302);
      // Sent to the server's own error page, never to the unlisted callback or the consent page.
      const redirected = new URL(location!);
      expect(redirected.pathname).toBe('/api/auth/error');
      expect(redirected.searchParams.get('error')).toBe('invalid_redirect');
    });

    it('disables the consent update/delete and session-JWT endpoints; consent still works', async () => {
      const clientId = await registerClaude();
      const viewer = await signInHeaders(auth, 'viewer@example.com');
      const callback = await authorizeAndConsent(viewer, clientId, pkce().challenge);
      expect(callback.searchParams.get('code')).toBeTruthy();
      const [consent] = await db
        .select()
        .from(schema.oauthConsent)
        .where(eq(schema.oauthConsent.clientId, clientId));
      expect(consent).toBeTruthy();

      // The session-backed endpoints would let a viewer widen their own consent to pfm:write
      // (the consent hook only guards /oauth2/consent) or mint a bare session JWT.
      const update = await post(
        auth,
        '/oauth2/update-consent',
        { id: consent!.id, update: { scopes: ['pfm:read', 'pfm:write'] } },
        viewer,
      );
      expect(update.status).toBe(404);
      const del = await post(auth, '/oauth2/delete-consent', { id: consent!.id }, viewer);
      expect(del.status).toBe(404);
      const jwt = await get(auth, '/token', viewer);
      expect(jwt.status).toBe(404);
      const [after] = await db
        .select()
        .from(schema.oauthConsent)
        .where(eq(schema.oauthConsent.clientId, clientId));
      expect(after!.scopes).toEqual(consent!.scopes);
    });

    it('does not put a session JWT in the get-session response headers', async () => {
      const member = await signInHeaders(auth, 'member2@example.com');
      const res = await get(auth, '/get-session', member);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-auth-jwt')).toBeNull();
    });

    it('rejects registration carrying logout URIs the server never uses', async () => {
      for (const extra of [
        { backchannel_logout_uri: 'https://claude.ai/logout' },
        { post_logout_redirect_uris: ['https://claude.ai/bye'] },
      ]) {
        const res = await post(auth, '/oauth2/register', {
          client_name: 'Claude',
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: 'none',
          ...extra,
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code?: string }).code).toBe('invalid_client_metadata');
      }
    });

    it('limits dynamic client registration to 10 per hour per client IP', async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await register([CLAUDE_CALLBACK], { 'x-real-ip': ip })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe('discovery', () => {
    it('advertises S256, offline_access, token auth none and the registration endpoint', async () => {
      const res = await auth.handler(
        new Request(rootUrl('/api/auth/.well-known/oauth-authorization-server')),
      );
      expect(res.status).toBe(200);
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta.issuer).toBe(`${BASE_URL}/api/auth`);
      expect(meta.code_challenge_methods_supported).toEqual(['S256']);
      expect(meta.scopes_supported).toEqual(
        expect.arrayContaining(['offline_access', 'pfm:read', 'pfm:write']),
      );
      expect(meta.registration_endpoint).toBe(`${BASE_URL}/api/auth/oauth2/register`);
      expect(meta.token_endpoint).toBe(`${BASE_URL}/api/auth/oauth2/token`);
      expect(meta.token_endpoint_auth_methods_supported).toContain('none');
      expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(meta.client_id_metadata_document_supported).toBe(true);
    });

    it('serves protected resource metadata whose resource is the MCP URL exactly', async () => {
      const res = await auth.handler(
        new Request(rootUrl('/.well-known/oauth-protected-resource/api/mcp')),
      );
      expect(res.status).toBe(200);
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta.resource).toBe(RESOURCE);
      expect(meta.authorization_servers).toEqual([`${BASE_URL}/api/auth`]);
    });
  });
});
