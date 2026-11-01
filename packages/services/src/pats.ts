import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Db } from '@arfolio/db';
import {
  assertUuid,
  ForbiddenError,
  NotFoundError,
  parseInput,
  type Role,
  type ServiceCtx,
} from './context.js';
import { recordAudit } from './audit.js';

const { personalAccessToken, member } = schema;

const TOKEN_PREFIX = 'pfm_pat_';
/** The token is `pfm_pat_` + 43 base64url characters (32 random bytes). */
const TOKEN_PATTERN = /^pfm_pat_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_LENGTH = 12;
const LAST_USED_THROTTLE_MS = 60_000;
const DAY_MS = 86_400_000;

export type PatScope = 'read' | 'read_write';
export type McpScope = 'pfm:read' | 'pfm:write';

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(['read', 'read_write']),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});

export type CreatePatInput = z.input<typeof createSchema>;

/** A token as the settings UI sees it: never the hash, and never the token itself. */
export type Pat = {
  id: string;
  name: string;
  scope: PatScope;
  /** First 12 characters of the token, for recognising it in a list. */
  prefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const patColumns = {
  id: personalAccessToken.id,
  name: personalAccessToken.name,
  scope: personalAccessToken.scope,
  prefix: personalAccessToken.prefix,
  expiresAt: personalAccessToken.expiresAt,
  lastUsedAt: personalAccessToken.lastUsedAt,
  revokedAt: personalAccessToken.revokedAt,
  createdAt: personalAccessToken.createdAt,
};

const toPat = (row: Omit<Pat, 'scope'> & { scope: string }): Pat => ({
  ...row,
  scope: row.scope as PatScope,
});

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/**
 * Creates a personal access token for the caller (any role: it is their own credential). A viewer
 * can only hold a read token. The plain token is returned here and nowhere else: only its sha256
 * is stored. Audited as `pat.create` in the same transaction.
 */
export async function createPat(
  ctx: ServiceCtx,
  rawInput: CreatePatInput,
): Promise<{ token: string; pat: Pat }> {
  const input = parseInput(createSchema, rawInput);
  if (ctx.role === 'viewer' && input.scope !== 'read') {
    throw new ForbiddenError('Viewers can only create read-only tokens');
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const pat = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .insert(personalAccessToken)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        name: input.name,
        tokenHash: hashToken(token),
        prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
        scope: input.scope,
        expiresAt:
          input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * DAY_MS),
      })
      .returning(patColumns);
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'pat.create',
      targetType: 'pat',
      targetId: row!.id,
    });
    return toPat(row!);
  });
  return { token, pat };
}

/** The caller's own tokens (revoked ones included), newest first. */
export async function listMyPats(ctx: ServiceCtx): Promise<Pat[]> {
  const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select(patColumns)
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ctx.userId))
      .orderBy(desc(personalAccessToken.createdAt), desc(personalAccessToken.id)),
  );
  return rows.map(toPat);
}

/**
 * Revokes one of the caller's own tokens. Idempotent: revoking an already revoked token succeeds
 * and changes nothing (and writes no second audit row). Someone else's token, or an unknown id, is
 * "not found". Audited as `pat.revoke` when it actually revokes.
 */
export async function revokePat(ctx: ServiceCtx, id: string): Promise<void> {
  assertUuid(id, 'Token');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const revoked = await tx
      .update(personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(personalAccessToken.id, id),
          eq(personalAccessToken.userId, ctx.userId),
          isNull(personalAccessToken.revokedAt),
        ),
      )
      .returning({ id: personalAccessToken.id });
    if (revoked.length > 0) {
      await recordAudit(tx, ctx, {
        actor: 'web',
        action: 'pat.revoke',
        targetType: 'pat',
        targetId: id,
      });
      return;
    }
    const [own] = await tx
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(and(eq(personalAccessToken.id, id), eq(personalAccessToken.userId, ctx.userId)));
    if (!own) throw new NotFoundError('Token');
  });
}

export type VerifiedPat = {
  patId: string;
  householdId: string;
  userId: string;
  role: Role;
  scopes: ReadonlySet<McpScope>;
};

function scopesOf(scope: PatScope, role: Role): ReadonlySet<McpScope> {
  // A viewer's read_write token (created before a demotion) must not write.
  return scope === 'read_write' && role !== 'viewer'
    ? new Set<McpScope>(['pfm:read', 'pfm:write'])
    : new Set<McpScope>(['pfm:read']);
}

/**
 * Resolves a bearer token to who it acts as, or null. There is no household yet, so the row is
 * found through the security-definer pat_lookup() (migration 0030); the household's role is then
 * read from `member` on EVERY call, inside withHousehold for the household found. Null (never a
 * distinguishing error) for: a malformed or wrong-prefix token, an unknown hash, a revoked or
 * expired token, a user who is no longer a member. `last_used_at` is bumped at most once a minute.
 */
export async function verifyPat(db: Db, token: string, now: Date): Promise<VerifiedPat | null> {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const { rows } = await db.execute<{
    id: string;
    household_id: string;
    user_id: string;
    scope: PatScope;
    live: boolean;
  }>(sql`select p.id, p.household_id, p.user_id, p.scope,
                (p.revoked_at is null and (p.expires_at is null or p.expires_at > ${now.toISOString()}::timestamptz)) as live
         from pat_lookup(${hashToken(token)}) p`);
  const found = rows[0];
  if (!found?.live) return null;
  return withHousehold(db, found.household_id, async (tx) => {
    const [m] = await tx
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, found.household_id), eq(member.userId, found.user_id)));
    if (!m) return null;
    const role = m.role as Role;
    await tx
      .update(personalAccessToken)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(personalAccessToken.id, found.id),
          or(
            isNull(personalAccessToken.lastUsedAt),
            lt(personalAccessToken.lastUsedAt, new Date(now.getTime() - LAST_USED_THROTTLE_MS)),
          ),
        ),
      );
    return {
      patId: found.id,
      householdId: found.household_id,
      userId: found.user_id,
      role,
      scopes: scopesOf(found.scope, role),
    };
  });
}
