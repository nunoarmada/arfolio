import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { FALLBACK_LOCALE } from '../i18n/locales';
import { isRole, ROLES, type Role } from '../lib/access';
import { getAuth, type Auth } from '../lib/auth';
import { nameSchema, passwordSchema } from '../lib/credentials';
import { getDb } from '../lib/db';
import { withUserCreation } from '../lib/user-creation';
import { getSessionContext } from './session';

/** The invitation or its registration token is unknown, wrong, expired, used or malformed. */
export class InvalidInvitationError extends Error {
  constructor() {
    super('Invitation is invalid or expired');
    this.name = 'InvalidInvitationError';
  }
}

/** The caller may not create invitations (not an owner). */
export class NotAllowedError extends Error {
  constructor() {
    super('Only household owners can invite members');
    this.name = 'NotAllowedError';
  }
}

/** An owner must enable two-factor authentication before managing the household. */
export class TwoFactorRequiredError extends Error {
  constructor() {
    super('Two-factor authentication must be enabled first');
    this.name = 'TwoFactorRequiredError';
  }
}

export interface InvitationDeps {
  db: Db;
  auth: Auth;
}

export interface CreateInvitationDeps extends InvitationDeps {
  /** Delivers the registration link; wire an SMTP sender here once mail is configured. */
  sendInvitationEmail?: (msg: {
    to: string;
    /** Registration path with the raw token (`/invite/<id>?t=<token>`). */
    link: string;
    role: Role;
    householdName: string;
    inviterName: string;
    /** The household's language, used for the email. */
    locale: string;
  }) => Promise<void>;
}

const TOKEN_BYTES = 32;

/** Compensating action: a failure is logged (message only) and never replaces the original error. */
async function cleanup(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(
      `invitation cleanup failed (${what}): ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashInvitationToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

const createInputSchema = z.object({ email: z.email(), role: z.enum(ROLES) });

/**
 * Owner-only. Creates the invitation through Better Auth, then a separate random registration
 * token whose sha256 is stored; the raw token is returned once (in `path`) for the inviter to
 * share, because the invitation id alone is visible to other members and must not be enough to
 * register.
 */
export async function createInvitation(
  input: { headers: Headers; email: string; role: Role },
  deps: CreateInvitationDeps = { db: getDb(), auth: getAuth() },
): Promise<{ invitationId: string; token: string; path: string; expiresAt: Date }> {
  const { db, auth } = deps;
  const { email, role } = createInputSchema.parse({ email: input.email, role: input.role });
  const ctx = await getSessionContext(input.headers, deps);
  if (!ctx || ctx.role !== 'owner') throw new NotAllowedError();
  if (!ctx.user.twoFactorEnabled) throw new TwoFactorRequiredError();

  const invitation = await auth.api.createInvitation({
    headers: input.headers,
    body: { email, role, organizationId: ctx.householdId },
  });

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    await db.insert(schema.invitationToken).values({
      invitationId: invitation.id,
      tokenHash: hashInvitationToken(token),
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    await cleanup('invitation', () =>
      db.delete(schema.invitation).where(eq(schema.invitation.id, invitation.id)),
    );
    throw error;
  }

  const path = `/invite/${invitation.id}?t=${token}`;
  if (deps.sendInvitationEmail) {
    const [org] = await db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.householdId));
    const [settings] = await withHousehold(db, ctx.householdId, (tx) =>
      tx.select({ locale: schema.householdSettings.locale }).from(schema.householdSettings),
    );
    await deps.sendInvitationEmail({
      to: email.toLowerCase(),
      link: path,
      role,
      householdName: org?.name ?? '',
      inviterName: ctx.user.name,
      locale: settings?.locale ?? FALLBACK_LOCALE,
    });
  }
  return { invitationId: invitation.id, token, path, expiresAt: invitation.expiresAt };
}

export interface InvitationPreview {
  email: string;
  role: Role;
  householdName: string;
  inviterName: string;
  expiresAt: Date;
}

/**
 * What the invite page shows. Returns null unless the invitation is pending, unexpired AND the
 * registration token matches, so expired, used, revoked and wrongly-tokened links look the same
 * and an invitation id alone reveals nothing.
 */
export async function getInvitationPreview(
  invitationId: string,
  token: string,
  deps: Pick<InvitationDeps, 'db'> = { db: getDb() },
): Promise<InvitationPreview | null> {
  const { db } = deps;
  if (!invitationId || !token) return null;
  const invitation = await findPendingInvitation(db, invitationId);
  if (
    !invitation ||
    !invitation.role ||
    !isRole(invitation.role) ||
    !(await hasValidToken(db, invitation.id, token))
  ) {
    return null;
  }
  const [org] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, invitation.organizationId));
  const [inviter] = await db
    .select({ name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, invitation.inviterId));
  if (!org || !inviter) return null;
  return {
    email: invitation.email,
    role: invitation.role,
    householdName: org.name,
    inviterName: inviter.name,
    expiresAt: invitation.expiresAt,
  };
}

const acceptInputSchema = z.object({
  invitationId: z.string().min(1),
  token: z.string().min(1),
  name: nameSchema,
  password: passwordSchema,
});

async function findPendingInvitation(db: Db, invitationId: string) {
  const [row] = await db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.status, 'pending'),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    );
  return row;
}

async function hasValidToken(db: Db, invitationId: string, token: string): Promise<boolean> {
  const [row] = await db
    .select({ tokenHash: schema.invitationToken.tokenHash })
    .from(schema.invitationToken)
    .where(
      and(
        eq(schema.invitationToken.invitationId, invitationId),
        isNull(schema.invitationToken.usedAt),
        gt(schema.invitationToken.expiresAt, new Date()),
      ),
    );
  return row !== undefined && tokenMatches(token, row.tokenHash);
}

/**
 * Lets an invitee without an account register. Needs the invitation id AND its registration
 * token. The email always comes from the invitation, never from the caller. Creates the user,
 * marks the invitation accepted and the token used, and adds the membership with the invited role
 * (the last three in one transaction).
 */
export async function acceptInvitationAndRegister(
  rawInput: z.input<typeof acceptInputSchema>,
  deps: InvitationDeps = { db: getDb(), auth: getAuth() },
): Promise<{ userId: string; householdId: string; role: Role; email: string }> {
  const { db, auth } = deps;
  const input = acceptInputSchema.parse(rawInput);

  const invitation = await findPendingInvitation(db, input.invitationId);
  if (
    !invitation ||
    !invitation.role ||
    !isRole(invitation.role) ||
    !(await hasValidToken(db, invitation.id, input.token))
  ) {
    throw new InvalidInvitationError();
  }
  const role = invitation.role;

  const { user } = await withUserCreation({ kind: 'invitation', email: invitation.email }, () =>
    auth.api.createUser({
      body: { email: invitation.email, name: input.name, password: input.password },
    }),
  );

  try {
    await db.transaction(async (tx) => {
      // Compare-and-set on both rows so a concurrent acceptance cannot reuse the invitation.
      const usedToken = await tx
        .update(schema.invitationToken)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.invitationToken.invitationId, invitation.id),
            isNull(schema.invitationToken.usedAt),
          ),
        )
        .returning({ id: schema.invitationToken.invitationId });
      const accepted = await tx
        .update(schema.invitation)
        .set({ status: 'accepted' })
        .where(
          and(eq(schema.invitation.id, invitation.id), eq(schema.invitation.status, 'pending')),
        )
        .returning({ id: schema.invitation.id });
      if (usedToken.length === 0 || accepted.length === 0) throw new InvalidInvitationError();
      await tx.insert(schema.member).values({
        id: randomUUID(),
        organizationId: invitation.organizationId,
        userId: user.id,
        role,
        createdAt: new Date(),
      });
    });
  } catch (error) {
    await cleanup('user', () => db.delete(schema.user).where(eq(schema.user.id, user.id)));
    throw error;
  }
  return { userId: user.id, householdId: invitation.organizationId, role, email: invitation.email };
}
