import { and, eq } from 'drizzle-orm';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { schema, type Db } from '@arfolio/db';
import { createArfolioMcpServer, type McpCaller } from '@arfolio/mcp';
import { verifyPat, type McpScope, type ServiceCtx } from '@arfolio/services';
import type { Auth } from '../lib/auth';
import type { Env } from '../lib/env';
import { grantableScopes, resolveMcpHousehold } from '../lib/mcp-consent';

const PAT_PREFIX = 'pfm_pat_';
const MCP_SCOPES: readonly McpScope[] = ['pfm:read', 'pfm:write'];
/** Version reported in the MCP `initialize` result. */
const MCP_SERVER_VERSION = '1.0.0';
/** JSON-RPC server-error codes (the -32000 range is implementation-defined). */
const RPC_INVALID_REQUEST = -32600;
const RPC_UNAUTHORIZED = -32001;
const RPC_RATE_LIMITED = -32029;
const RPC_INTERNAL = -32603;
/** The jwt() plugin runs with its defaults, which sign with EdDSA. */
const JWT_ALGORITHMS = ['EdDSA'];

export type McpEndpointDeps = {
  db: Db;
  auth: Auth;
  env: Pick<Env, 'APP_URL' | 'BRAND_NAME'>;
  /** 120 requests a minute per credential in production (see the route). */
  limiter: { take(key: string, now?: number): boolean };
  now?: () => Date;
};

/** A request whose credential resolved: who it acts as, its rate-limit bucket and the SDK auth info. */
export type ResolvedMcpRequest = { caller: McpCaller; rateKey: string; authInfo: AuthInfo };

const NO_STORE = { 'cache-control': 'no-store' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * A JSON array body is a JSON-RPC batch: many calls for one rate-limit token. Not supported.
 * Reads a clone, so the SDK still gets the untouched request; unparsable bodies are left to it.
 */
async function isBatch(req: Request): Promise<boolean> {
  if (req.method !== 'POST') return false;
  try {
    return Array.isArray(await req.clone().json());
  } catch {
    return false;
  }
}

/** 401 for a missing, malformed, unknown, expired, revoked or wrongly-bound credential. */
function unauthorized(appUrl: string): Response {
  const resourceMetadata = `${appUrl}/.well-known/oauth-protected-resource/api/mcp`;
  return json(401, rpcError(RPC_UNAUTHORIZED, 'Unauthorized'), {
    'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
  });
}

const twoFactorRequired = () => json(403, { error: 'two_factor_required' });
const householdUnresolved = () => json(403, { error: 'household_unresolved' });

/** Owners must use two-factor, as everywhere else in the app (auth-guards). */
async function ownerLacksTwoFactor(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return !row?.enabled;
}

/** jose reports a bad token (malformed, expired, bad signature, wrong claim) as an ERR_J* error. */
const isTokenProblem = (error: unknown): boolean =>
  error instanceof Error && /^ERR_J/.test(String((error as { code?: unknown }).code));

/** A compact JWS whose header is a JSON object; anything else is not a token this server issued. */
function hasJwtShape(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false; // opaque tokens are not accepted
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && !Array.isArray(header);
  } catch {
    return false;
  }
}

/**
 * Verifies an OAuth access token in-process: signature against this server's own JWKS (read through
 * `auth.api`, never over HTTP), the Better Auth issuer, `aud` containing the MCP resource, and `exp`.
 */
async function verifyAccessToken(
  token: string,
  deps: McpEndpointDeps,
): Promise<Record<string, unknown> | null> {
  if (!hasJwtShape(token)) return null;
  const { baseURL } = await deps.auth.$context;
  try {
    const claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => deps.auth.api.getJwks(),
      jwksCacheKey: deps.auth,
      verifyOptions: {
        issuer: baseURL,
        audience: `${deps.env.APP_URL}/api/mcp`,
        algorithms: JWT_ALGORITHMS,
        currentDate: (deps.now ?? (() => new Date()))(),
      },
    });
    // Sender-constrained (DPoP) tokens need a proof this endpoint does not check.
    if ((claims.cnf as { jkt?: unknown } | undefined)?.jkt) return null;
    return claims;
  } catch (error) {
    if (isTokenProblem(error)) return null;
    throw error;
  }
}

async function resolvePat(
  token: string,
  deps: McpEndpointDeps,
): Promise<ResolvedMcpRequest | Response> {
  const pat = await verifyPat(deps.db, token, (deps.now ?? (() => new Date()))());
  if (!pat) return unauthorized(deps.env.APP_URL);
  if (pat.role === 'owner' && (await ownerLacksTwoFactor(deps.db, pat.userId))) {
    return twoFactorRequired();
  }
  const credential = `pat:${pat.patId}`;
  return {
    caller: {
      ctx: { db: deps.db, householdId: pat.householdId, userId: pat.userId, role: pat.role },
      scopes: pat.scopes,
      credential,
    },
    rateKey: credential,
    authInfo: { token, clientId: credential, scopes: [...pat.scopes] },
  };
}

async function resolveOAuth(
  token: string,
  deps: McpEndpointDeps,
): Promise<ResolvedMcpRequest | Response> {
  const claims = await verifyAccessToken(token, deps);
  const sub = claims?.sub;
  const clientId = claims?.client_id ?? claims?.azp;
  if (!claims || typeof sub !== 'string' || typeof clientId !== 'string') {
    return unauthorized(deps.env.APP_URL);
  }
  // Revoking a connected app deletes its consent: the token stops working at once, though its
  // signature and expiry are still good. A disabled client is refused the same way, and so is a
  // token issued before the current consent (revoked, then connected again): it belonged to the
  // grant that was revoked. `iat` has whole seconds, so the consent time is floored to match.
  const [grant] = await deps.db
    .select({
      disabled: schema.oauthClient.disabled,
      grantedAt: schema.oauthConsent.createdAt,
    })
    .from(schema.oauthConsent)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(and(eq(schema.oauthConsent.userId, sub), eq(schema.oauthConsent.clientId, clientId)));
  const issuedAt = typeof claims.iat === 'number' ? claims.iat : -Infinity;
  if (!grant || grant.disabled || issuedAt < Math.floor(grant.grantedAt.getTime() / 1000)) {
    return unauthorized(deps.env.APP_URL);
  }

  // The membership and its role are read on every request: a removed member or a demoted one
  // loses access at once, whatever the token was granted.
  const household = await resolveMcpHousehold(deps.db, sub);
  if (household.kind !== 'resolved') return householdUnresolved();
  const role = household.role as ServiceCtx['role'];
  if (role === 'owner' && (await ownerLacksTwoFactor(deps.db, sub))) return twoFactorRequired();

  const granted = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
  // Only writer roles may hold pfm:write (the consent rule), so an unknown role fails closed.
  const allowed = new Set(grantableScopes(granted, role));
  const scopes = new Set(MCP_SCOPES.filter((scope) => allowed.has(scope)));
  return {
    caller: {
      ctx: { db: deps.db, householdId: household.householdId, userId: sub, role },
      scopes,
      credential: `oauth:${clientId}`,
    },
    rateKey: `oauth:${sub}:${clientId}`,
    authInfo: {
      token,
      clientId,
      scopes: [...scopes],
      ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
    },
  };
}

/**
 * Resolves the Bearer credential of an MCP request: a personal access token (`pfm_pat_...`) or an
 * OAuth access token. Bearer is the only credential (cookies are never read). Returns the caller,
 * or the 401/403 response to send.
 */
export async function resolveMcpCaller(
  req: Request,
  deps: McpEndpointDeps,
): Promise<ResolvedMcpRequest | Response> {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!match) return unauthorized(deps.env.APP_URL);
  const token = match[1]!;
  return token.startsWith(PAT_PREFIX) ? resolvePat(token, deps) : resolveOAuth(token, deps);
}

/**
 * The `/api/mcp` request handler: authenticate, rate limit, then serve one stateless MCP exchange
 * from a fresh server built for this caller.
 */
export function createMcpRequestHandler(
  deps: McpEndpointDeps,
): (req: Request) => Promise<Response> {
  const serve = async (req: Request): Promise<Response> => {
    const resolved = await resolveMcpCaller(req, deps);
    if (resolved instanceof Response) return resolved;
    if (!deps.limiter.take(resolved.rateKey)) {
      return json(429, rpcError(RPC_RATE_LIMITED, 'Too many requests'), { 'retry-after': '60' });
    }
    if (await isBatch(req)) {
      return json(400, rpcError(RPC_INVALID_REQUEST, 'Batch requests are not supported'));
    }
    const mcp = createMcpHandler(
      () =>
        createArfolioMcpServer(resolved.caller, {
          brandName: deps.env.BRAND_NAME,
          version: MCP_SERVER_VERSION,
        }),
      { legacy: 'stateless' },
    );
    const res = await mcp.fetch(req, { authInfo: resolved.authInfo });
    const headers = new Headers(res.headers);
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return async (req) => {
    try {
      return await serve(req);
    } catch (error) {
      // No detail to the caller; the log carries only the error's name (never token or data).
      console.error(`mcp request failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return json(500, rpcError(RPC_INTERNAL, 'Internal error'));
    }
  };
}
