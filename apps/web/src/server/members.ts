import { and, asc, eq, gt } from 'drizzle-orm';
import { schema } from '@arfolio/db';
import { isRole, type Role } from '../lib/access';
import { getAuth } from '../lib/auth';
import { getDb } from '../lib/db';
import { requireMember, type SessionDeps } from './session';

export class MemberActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberActionError';
  }
}

export interface MemberRow {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  isSelf: boolean;
}

export interface PendingInvitationRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

const resolveDeps = (deps?: SessionDeps): SessionDeps => deps ?? { db: getDb(), auth: getAuth() };

/** The household's members, oldest first. Every member may see the list. */
export async function listMembers(headers: Headers, deps?: SessionDeps): Promise<MemberRow[]> {
  const d = resolveDeps(deps);
  const ctx = await requireMember(headers, {}, d);
  const rows = await d.db
    .select({
      memberId: schema.member.id,
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, ctx.householdId))
    .orderBy(asc(schema.member.createdAt), asc(schema.user.email));
  return rows.flatMap((r) =>
    isRole(r.role) ? [{ ...r, role: r.role, isSelf: r.userId === ctx.user.id }] : [],
  );
}

/** Open invitations that have not expired. Owners only: the list hides who was invited. */
export async function listPendingInvitations(
  headers: Headers,
  deps?: SessionDeps,
): Promise<PendingInvitationRow[]> {
  const d = resolveDeps(deps);
  const ctx = await requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, d);
  const rows = await d.db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, ctx.householdId),
        eq(schema.invitation.status, 'pending'),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(schema.invitation.expiresAt));
  return rows.flatMap((r) =>
    r.role && isRole(r.role)
      ? [{ id: r.id, email: r.email, role: r.role, expiresAt: r.expiresAt }]
      : [],
  );
}

/** Owner-only. Cancels an open invitation of this household; its link stops working at once. */
export async function revokeInvitation(
  headers: Headers,
  invitationId: string,
  deps?: SessionDeps,
): Promise<void> {
  const d = resolveDeps(deps);
  const ctx = await requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, d);
  const [row] = await d.db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.organizationId, ctx.householdId),
      ),
    );
  if (!row) throw new MemberActionError('Invitation not found');
  await d.auth.api.cancelInvitation({ headers, body: { invitationId } });
}

/**
 * Owner-only. Removes a member of this household. Owners cannot remove themselves (Better Auth
 * additionally refuses to remove the last owner), and the removed user's sessions are ended. A
 * user left with no household is deleted so the email can be invited again.
 */
export async function removeMember(
  headers: Headers,
  memberId: string,
  deps?: SessionDeps,
): Promise<void> {
  const d = resolveDeps(deps);
  const ctx = await requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, d);
  const [target] = await d.db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, ctx.householdId)));
  if (!target) throw new MemberActionError('Member not found');
  if (target.userId === ctx.user.id) throw new MemberActionError('You cannot remove yourself');
  // The member's push devices of this household go with the `member` row (database trigger).
  await d.auth.api.removeMember({
    headers,
    body: { memberIdOrEmail: memberId, organizationId: ctx.householdId },
  });
  await d.db.delete(schema.session).where(eq(schema.session.userId, target.userId));
  // Better Auth keeps the user row, which would block inviting the same email again. Once they
  // belong to no household the account is useless, so drop it (sessions, accounts and 2FA data
  // cascade). A user who still belongs to another household is left untouched.
  const remaining = await d.db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, target.userId))
    .limit(1);
  if (remaining.length === 0) {
    await d.db.delete(schema.user).where(eq(schema.user.id, target.userId));
  }
}
