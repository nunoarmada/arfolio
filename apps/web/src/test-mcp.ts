import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@arfolio/db';
import type { Auth } from './lib/auth';
import { acceptInvitationAndRegister, hashInvitationToken } from './server/invitations';
import { BASE_URL, freshIp, get, PASSWORD, post, signInHeaders } from './test-utils';

/** Shared by the MCP OAuth and endpoint tests: the Claude connector's OAuth flow, in-process. */
export const MCP_RESOURCE = `${BASE_URL}/api/mcp`;
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const MCP_TEST_SCOPES = 'openid profile email offline_access pfm:read pfm:write';

const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

/** Accepts an invitation for `email` into `householdId` with `role` (password: PASSWORD). */
export async function addMember(
  deps: { db: Db; auth: Auth },
  householdId: string,
  ownerEmail: string,
  email: string,
  role: string,
): Promise<void> {
  const [owner] = await deps.db.select().from(schema.user).where(eq(schema.user.email, ownerEmail));
  const id = `inv-${email}`;
  const expiresAt = new Date(Date.now() + 60_000);
  await deps.db
    .insert(schema.invitation)
    .values({ id, organizationId: householdId, email, role, expiresAt, inviterId: owner!.id });
  await deps.db
    .insert(schema.invitationToken)
    .values({ invitationId: id, tokenHash: hashInvitationToken('t'), expiresAt });
  await acceptInvitationAndRegister(
    { invitationId: id, token: 't', name: email, password: PASSWORD },
    deps,
  );
}

export async function registerClient(
  auth: Auth,
  redirectUris: string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return post(
    auth,
    '/oauth2/register',
    {
      client_name: 'Claude',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_type: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_TEST_SCOPES,
    },
    headers,
  );
}

export async function registerClaude(auth: Auth): Promise<string> {
  const res = await registerClient(auth, [CLAUDE_CALLBACK]);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(
  clientId: string,
  challenge: string | null,
  scope = MCP_TEST_SCOPES,
  resource = MCP_RESOURCE,
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope,
    state: 'xyz',
    resource,
  });
  if (challenge) {
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
  }
  return `/oauth2/authorize?${q}`;
}

/** Runs authorize + consent and returns the callback URL the browser would be sent to. */
export async function authorizeAndConsent(
  auth: Auth,
  headers: Record<string, string>,
  clientId: string,
  challenge: string,
  consent: { accept: boolean; scope?: string } = { accept: true },
): Promise<URL> {
  const authz = await get(auth, authorizeUrl(clientId, challenge), headers);
  if (authz.status !== 302) throw new Error(`authorize: ${authz.status}`);
  const consentUrl = new URL(authz.headers.get('location')!, BASE_URL);
  const res = await post(
    auth,
    '/oauth2/consent',
    { ...consent, oauth_query: consentUrl.search.slice(1) },
    headers,
  );
  if (res.status !== 200) throw new Error(`consent: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { url?: string; redirect_uri?: string };
  return new URL(body.url ?? body.redirect_uri!);
}

export async function tokenRequest(auth: Auth, params: Record<string, string>): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': freshIp() },
      body: new URLSearchParams(params),
    }),
  );
}

/** Signs `email` in and walks the whole OAuth flow; returns the access token response. */
export async function mintOAuthToken(
  auth: Auth,
  email: string,
  opts: { resource?: string } = {},
): Promise<{ access_token: string; scope: string; clientId: string }> {
  const clientId = await registerClaude(auth);
  const headers = await signInHeaders(auth, email);
  const { verifier, challenge } = pkce();
  const callback = await authorizeAndConsent(auth, headers, clientId, challenge);
  const exchanged = await tokenRequest(auth, {
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    redirect_uri: CLAUDE_CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
    resource: opts.resource ?? MCP_RESOURCE,
  });
  if (exchanged.status !== 200)
    throw new Error(`token: ${exchanged.status} ${await exchanged.text()}`);
  return { ...((await exchanged.json()) as { access_token: string; scope: string }), clientId };
}
