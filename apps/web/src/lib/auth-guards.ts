import { and, eq, lt, ne, sql } from 'drizzle-orm';
import {
  APIError,
  createAuthMiddleware,
  getIP,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api';
import { schema, type Db } from '@arfolio/db';
import { nameSchema } from './credentials';
import {
  credentialFingerprint,
  hasKnownDeviceCookie,
  isValidKnownDeviceValue,
  KNOWN_DEVICE_MAX_AGE_S,
  knownDeviceCookieName,
  knownDeviceValue,
} from './known-device';
import { isFreshSession } from './fresh-session';
import { grantableScopes, resolveMcpHousehold } from './mcp-consent';
import { isAllowedMcpRedirectUri } from './mcp-redirect';

/** Attempts allowed per (email, client IP) per window. */
export const LOCKOUT_MAX_PER_IP = 10;
/** Attempts allowed per email per window across all IPs (distributed guessing). */
export const LOCKOUT_MAX_PER_EMAIL = 50;
/** The same ceiling for a browser holding the account's known-device cookie. */
export const LOCKOUT_MAX_PER_EMAIL_KNOWN_DEVICE = 200;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;

const SIGN_IN_PATH = '/sign-in/email';
const VERIFY_TOTP_PATH = '/two-factor/verify-totp';
const OAUTH_REGISTER_PATH = '/oauth2/register';
const OAUTH_AUTHORIZE_PATH = '/oauth2/authorize';
const OAUTH_CONSENT_PATH = '/oauth2/consent';
const UPDATE_USER_PATH = '/update-user';
/** SQL for "start of the lockout window", derived from LOCKOUT_WINDOW_MS. */
const windowStart = () =>
  sql`now() - make_interval(secs => ${LOCKOUT_WINDOW_MS / 1000}::double precision)`;
/**
 * Organisation endpoints that only read (several are POSTs). Anything else under /organization/
 * is treated as a mutation, including calls whose method is unknown (server-side auth.api.*).
 */
const ORGANIZATION_READS = new Set([
  '/organization/get-full-organization',
  '/organization/list',
  '/organization/get-organization',
  '/organization/list-roles',
  '/organization/get-role',
  '/organization/list-teams',
  '/organization/list-team-members',
  '/organization/list-user-teams',
  '/organization/list-members',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/get-invitation',
  '/organization/list-invitations',
  '/organization/list-user-invitations',
  '/organization/has-permission',
  '/organization/check-slug',
]);
/** Reads that expose invitations (the full organisation embeds them): owners only. */
const OWNER_ONLY_READS = new Set([
  '/organization/list-invitations',
  '/organization/get-full-organization',
]);

function genericSignInError(): APIError {
  // Same status and body as a plain wrong password, so a lock reveals nothing about the account.
  return APIError.from('UNAUTHORIZED', {
    code: 'INVALID_EMAIL_OR_PASSWORD',
    message: 'Invalid email or password',
  });
}

function emailOf(body: unknown): string {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Requests that may be enabling 2FA (the signed-in user did not have it yet): who, and which
 * session to keep. Settled by the after hook once the verification succeeded.
 */
const enrolments = new WeakMap<object, { userId: string; keepToken: string }>();

/** Per-request attempt rows, so the after hook can settle the row the before hook recorded. */
const attemptIds = new WeakMap<object, string>();

/**
 * Atomically records a sign-in attempt, refusing it when the limits are reached. A per-email
 * advisory lock serialises count+insert, so concurrent requests cannot all slip under the limit.
 * A known device (see {@link isKnownDevice}) gets a higher per-email ceiling, not an unlimited
 * one: the per-(email, IP) cap and the password check still apply. Returns the new attempt's id, or null
 * when the attempt is refused.
 */
async function recordAttempt(
  db: Db,
  email: string,
  ip: string,
  knownDevice: boolean,
): Promise<string | null> {
  const emailCeiling = knownDevice ? LOCKOUT_MAX_PER_EMAIL_KNOWN_DEVICE : LOCKOUT_MAX_PER_EMAIL;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`sign-in:${email}`}, 0))`);
    const window = windowStart();
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into sign_in_failure (email, ip)
      select ${email}, ${ip}
      where (select count(*) from sign_in_failure
             where email = ${email} and ip = ${ip} and attempted_at > ${window}) < ${LOCKOUT_MAX_PER_IP}
        and (select count(*) from sign_in_failure
             where email = ${email} and attempted_at > ${window}) < ${emailCeiling}
      returning id`);
    return rows[0]?.id ?? null;
  });
}

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** Fingerprint of the account's current credentials, or null for an unknown user. */
async function currentFingerprint(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({
      password: schema.account.password,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.user)
    .leftJoin(
      schema.account,
      and(eq(schema.account.userId, schema.user.id), eq(schema.account.providerId, 'credential')),
    )
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row ? credentialFingerprint(userId, row.password, row.twoFactorEnabled) : null;
}

/**
 * Whether the request carries the signed known-device cookie of the account `email` names (set
 * by an earlier successful sign-in from this browser). It only raises the per-email lockout
 * counter, so someone who merely knows the address cannot keep the owner out of their own
 * browser; it never replaces the password.
 */
async function isKnownDevice(db: Db, ctx: HookCtx, email: string): Promise<boolean> {
  if (!hasKnownDeviceCookie(ctx.headers?.get('cookie') ?? ctx.request?.headers.get('cookie'))) {
    return false;
  }
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  if (!row) return false;
  const value = await ctx.getSignedCookie(knownDeviceCookieName(row.id), ctx.context.secret);
  const fingerprint = await currentFingerprint(db, row.id);
  return fingerprint !== null && isValidKnownDeviceValue(value || null, row.id, fingerprint);
}

/** Remembers this browser for the signed-in user (HttpOnly, signed with the auth secret, tied to
 * the current password hash and 2FA flag). */
async function rememberDevice(db: Db, ctx: HookCtx, userId: string): Promise<void> {
  const fingerprint = await currentFingerprint(db, userId);
  if (!fingerprint) return;
  await ctx.setSignedCookie(
    knownDeviceCookieName(userId),
    knownDeviceValue(userId, fingerprint),
    ctx.context.secret,
    { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: KNOWN_DEVICE_MAX_AGE_S },
  );
}

/**
 * Before/after hooks for Better Auth:
 *  - sign-in throttling backed by Postgres: 10 attempts per (email, client IP) and 50 per email
 *    in 15 minutes, recorded before the password is checked. A browser holding the account's
 *    signed known-device cookie (set at a successful sign-in; void after a password change) gets
 *    a 200 per-email ceiling instead of 50, so a stranger cannot lock the owner out; the per-IP
 *    cap and the password still apply. Behind the ingress, CLIENT_IP_HEADER must be overwritten (not appended) so the
 *    per-IP cap cannot be dodged;
 *  - enabling 2FA (verify-totp by a user without it) revokes the user's other sessions;
 *  - organisation endpoints: owners need 2FA enabled to mutate (HTTP or server-side), and
 *    invitation data is visible to owners only;
 *  - profile updates: the display name follows nameSchema;
 *  - MCP OAuth: dynamic registration only accepts allowlisted redirect URIs, and consent (and authorize,
 *    which could skip it for a stored consent) needs a
 *    sign-in within the last 10 minutes and is only given for a user with exactly one household,
 *    with `pfm:write` dropped for non-writers.
 */
export function createAuthHooks(db: Db, opts: { extraRedirectUris?: readonly string[] } = {}) {
  const before = createAuthMiddleware(async (ctx) => {
    if (ctx.path === OAUTH_REGISTER_PATH) {
      const body = ctx.body as Record<string, unknown> | undefined;
      // Logout URIs would have the server call out to (or redirect to) client-chosen URLs; it
      // implements neither RP-initiated nor back-channel logout.
      if (body && ('backchannel_logout_uri' in body || 'post_logout_redirect_uris' in body)) {
        throw APIError.from('BAD_REQUEST', {
          code: 'invalid_client_metadata',
          message: 'logout URIs are not supported by this server',
        });
      }
      const uris = body?.redirect_uris;
      if (
        Array.isArray(uris) &&
        !uris.every(
          (u) => typeof u === 'string' && isAllowedMcpRedirectUri(u, opts.extraRedirectUris),
        )
      ) {
        throw APIError.from('BAD_REQUEST', {
          code: 'invalid_redirect_uri',
          message: 'redirect_uri is not allowed for this server',
        });
      }
      return;
    }

    if (ctx.path === UPDATE_USER_PATH) {
      // Better Auth stores any string: hold the display name to the same rules as setup.
      const body = (ctx.body ?? {}) as { name?: unknown };
      if (body.name === undefined) return;
      const parsed = nameSchema.safeParse(body.name);
      if (!parsed.success) {
        throw APIError.from('BAD_REQUEST', { code: 'INVALID_NAME', message: 'Invalid name' });
      }
      return { context: { body: { ...body, name: parsed.data } } };
    }

    if (ctx.path === OAUTH_AUTHORIZE_PATH) {
      // A stored consent lets authorize issue a code without the consent step: a session older
      // than the freshness window must go through the consent page (which asks to sign in again).
      const current = await getSessionFromCtx(ctx);
      if (!current || isFreshSession(current.session.createdAt)) return;
      const query = (ctx.query ?? {}) as Record<string, unknown>;
      const prompt = typeof query.prompt === 'string' ? query.prompt.split(' ') : [];
      if (prompt.includes('consent')) return;
      return { context: { query: { ...query, prompt: [...prompt, 'consent'].join(' ').trim() } } };
    }

    if (ctx.path === OAUTH_CONSENT_PATH) {
      const body = (ctx.body ?? {}) as { accept?: unknown; scope?: unknown; oauth_query?: unknown };
      if (body.accept !== true) return; // denying needs no household
      const current = await getSessionFromCtx(ctx);
      if (!current) return; // the endpoint itself rejects anonymous callers
      if (!isFreshSession(current.session.createdAt)) {
        throw APIError.from('FORBIDDEN', {
          code: 'SESSION_NOT_FRESH',
          message: 'Sign in again to grant access',
        });
      }
      const household = await resolveMcpHousehold(db, current.user.id);
      if (household.kind !== 'resolved') {
        throw APIError.from('FORBIDDEN', {
          code: 'household_unresolved',
          message: 'Access tokens need exactly one household; use a personal access token instead',
        });
      }
      if (household.role === 'owner' && !current.user.twoFactorEnabled) {
        // Same rule as the rest of the app (and the consent page): owners need 2FA first.
        throw APIError.from('FORBIDDEN', {
          code: 'TWO_FACTOR_REQUIRED',
          message: 'Owners must enable two-factor authentication first',
        });
      }
      const requested =
        typeof body.scope === 'string'
          ? body.scope
          : typeof body.oauth_query === 'string'
            ? (new URLSearchParams(body.oauth_query).get('scope') ?? '')
            : '';
      const granted = grantableScopes(requested.split(' ').filter(Boolean), household.role);
      return { context: { body: { ...body, scope: granted.join(' ') } } };
    }

    if (ctx.path === SIGN_IN_PATH) {
      const email = emailOf(ctx.body);
      if (!email) return; // malformed: the endpoint rejects it without checking any password
      const ip =
        getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? 'unknown';
      const id = await recordAttempt(db, email, ip, await isKnownDevice(db, ctx, email));
      if (!id) throw genericSignInError();
      attemptIds.set(ctx.context, id);
      return;
    }

    if (ctx.path === VERIFY_TOTP_PATH) {
      const current = await getSessionFromCtx(ctx);
      if (current && !current.user.twoFactorEnabled) {
        enrolments.set(ctx.context, { userId: current.user.id, keepToken: current.session.token });
      }
      return;
    }

    if (!ctx.path.startsWith('/organization/')) return;
    const current = await getSessionFromCtx(ctx);
    if (!current) return; // the endpoint itself rejects anonymous callers
    const memberships = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(eq(schema.member.userId, current.user.id));
    const isOwner = memberships.some((m) => m.role.split(',').includes('owner'));

    if (OWNER_ONLY_READS.has(ctx.path) && !isOwner) {
      throw APIError.from('FORBIDDEN', {
        code: 'OWNER_ONLY',
        message: 'Only owners can view invitations',
      });
    }
    // Unknown method (server-side auth.api.* calls) counts as a mutation unless the path is a read.
    const method = (ctx.method ?? ctx.request?.method ?? 'POST').toUpperCase();
    const isRead = method === 'GET' || ORGANIZATION_READS.has(ctx.path);
    if (!isRead && isOwner && !current.user.twoFactorEnabled) {
      throw APIError.from('FORBIDDEN', {
        code: 'TWO_FACTOR_REQUIRED',
        message: 'Owners must enable two-factor authentication first',
      });
    }
  });

  const after = createAuthMiddleware(async (ctx) => {
    if (ctx.path === VERIFY_TOTP_PATH) {
      const enrolment = enrolments.get(ctx.context);
      enrolments.delete(ctx.context);
      if (isAPIError(ctx.context.returned)) return; // wrong code: 2FA is still off
      // A second factor completes the sign-in of 2FA users: this browser is now known.
      const signedIn = ctx.context.newSession;
      if (signedIn) await rememberDevice(db, ctx, signedIn.user.id);
      if (!enrolment) return;
      // 2FA is now on: sessions opened with the password alone must not outlive the enrolment.
      // Better Auth swaps the current session for a fresh one when enabling, so keep that one.
      const keepToken = ctx.context.newSession?.session.token ?? enrolment.keepToken;
      await db
        .delete(schema.session)
        .where(
          and(eq(schema.session.userId, enrolment.userId), ne(schema.session.token, keepToken)),
        );
      return;
    }
    if (ctx.path !== SIGN_IN_PATH) return;
    const id = attemptIds.get(ctx.context);
    if (!id) return;
    attemptIds.delete(ctx.context);
    const returned = ctx.context.returned;
    if (isAPIError(returned) && returned.statusCode === 401) {
      // A failed credential check stays recorded. Keep the table small: drop rows that can no
      // longer count towards any limit.
      await db
        .delete(schema.signInFailure)
        .where(lt(schema.signInFailure.attemptedAt, windowStart()));
      return;
    }
    if (isAPIError(returned)) {
      // Failed for another reason (validation, ...): this was not a credential guess.
      await db.delete(schema.signInFailure).where(eq(schema.signInFailure.id, id));
      return;
    }
    // Success: remember this browser (2FA users get it after the second factor instead).
    const signedIn = ctx.context.newSession;
    // (The two-factor plugin turns the response into a redirect after this hook has run.)
    if (signedIn && !signedIn.user.twoFactorEnabled)
      await rememberDevice(db, ctx, signedIn.user.id);
    // Forget this client's earlier failures for the account.
    const [row] = await db
      .select({ email: schema.signInFailure.email, ip: schema.signInFailure.ip })
      .from(schema.signInFailure)
      .where(eq(schema.signInFailure.id, id));
    if (row) {
      await db
        .delete(schema.signInFailure)
        .where(and(eq(schema.signInFailure.email, row.email), eq(schema.signInFailure.ip, row.ip)));
    }
  });

  return { before, after };
}
