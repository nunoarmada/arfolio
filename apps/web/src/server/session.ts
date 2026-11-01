import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { schema, type Db } from '@arfolio/db';
import { isFreshSession } from '../lib/fresh-session';
import { isRole, type Role } from '../lib/access';
import { getAuth, type Auth } from '../lib/auth';
import { getDb } from '../lib/db';

type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

export interface SessionContext {
  user: AuthSession['user'];
  session: AuthSession['session'];
  householdId: string;
  role: Role;
}

/** A signed-in member attempted an action their role does not allow (HTTP 403). */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super('Your role does not allow this action');
    this.name = 'ForbiddenError';
  }
}

/** The action needs a recent sign-in and the session is older than that (HTTP 403). */
export class StaleSessionError extends Error {
  readonly status = 403;
  constructor() {
    super('Sign in again to continue');
    this.name = 'StaleSessionError';
  }
}

export interface SessionDeps {
  db: Db;
  auth: Auth;
}

type Resolved =
  { kind: 'anonymous' } | { kind: 'no-household' } | { kind: 'member'; ctx: SessionContext };

const defaultDeps = (): SessionDeps => ({ db: getDb(), auth: getAuth() });

async function resolve(headers: Headers, { db, auth }: SessionDeps): Promise<Resolved> {
  const current = await auth.api.getSession({ headers });
  if (!current) return { kind: 'anonymous' };

  const memberships = await db
    .select()
    .from(schema.member)
    .where(eq(schema.member.userId, current.user.id));
  // One household per installation for now; prefer the session's active one if there are several.
  const membership =
    memberships.find((m) => m.organizationId === current.session.activeOrganizationId) ??
    memberships[0];
  if (!membership || !isRole(membership.role)) return { kind: 'no-household' };

  return {
    kind: 'member',
    ctx: {
      user: current.user,
      session: current.session,
      householdId: membership.organizationId,
      role: membership.role,
    },
  };
}

/** The signed-in user's session with their household and role, or null if there is none. */
export async function getSessionContext(
  headers: Headers,
  deps: SessionDeps = defaultDeps(),
): Promise<SessionContext | null> {
  const resolved = await resolve(headers, deps);
  return resolved.kind === 'member' ? resolved.ctx : null;
}

/**
 * Guards a page or action: anonymous visitors go to /sign-in, owners must have 2FA enabled
 * (otherwise /two-factor/setup), and users outside a household get a 404 so the existence of the
 * household is not revealed. A role outside `opts.roles` also gets a 404 on pages; server actions
 * pass `onDenied: 'forbidden'` to get a {@link ForbiddenError} (403) they can report to the caller.
 * `fresh: true` additionally requires a sign-in within the last 10 minutes
 * ({@link StaleSessionError} otherwise), for actions that mint long-lived credentials.
 */
export async function requireMember(
  headers: Headers,
  opts: { roles?: Role[]; onDenied?: 'not-found' | 'forbidden'; fresh?: boolean } = {},
  deps: SessionDeps = defaultDeps(),
): Promise<SessionContext> {
  const resolved = await resolve(headers, deps);
  if (resolved.kind === 'anonymous') redirect('/sign-in');
  if (resolved.kind === 'no-household') notFound();
  const { ctx } = resolved;
  if (ctx.role === 'owner' && !ctx.user.twoFactorEnabled) redirect('/two-factor/setup');
  if (opts.roles && !opts.roles.includes(ctx.role)) {
    if (opts.onDenied === 'forbidden') throw new ForbiddenError();
    notFound();
  }
  if (opts.fresh && !isFreshSession(ctx.session.createdAt)) throw new StaleSessionError();
  return ctx;
}
