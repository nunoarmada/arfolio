import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { assertOwner, parseInput, ValidationError, type ServiceCtx } from './context.js';

const { auditLog } = schema;

export type AuditActor = 'mcp' | 'web';

export type AuditEntry = {
  actor: AuditActor;
  /** Dotted verb, e.g. `pat.create`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** `pat:<id>` or `oauth:<clientId>`. Never an amount, a token or any secret. */
  credential?: string;
};

/**
 * Appends one audit row for the caller's household and user. It takes the caller's open
 * transaction (inside withHousehold) so the row commits or rolls back with the change it
 * describes; the row records ids only.
 */
export async function recordAudit(tx: Tx, ctx: ServiceCtx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    householdId: ctx.householdId,
    userId: ctx.userId,
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    credential: entry.credential ?? null,
  });
}

export type AuditRow = {
  id: string;
  userId: string | null;
  actor: AuditActor;
  action: string;
  targetType: string | null;
  targetId: string | null;
  credential: string | null;
  createdAt: Date;
};

export type AuditPage = { items: AuditRow[]; nextCursor: string | null };

const DEFAULT_AUDIT_PAGE = 50;
const MAX_AUDIT_PAGE = 200;

const listAuditSchema = z.strictObject({
  limit: z.number().int().min(1).optional(),
  cursor: z.string().max(200).optional(),
});

// Microsecond text, because a JS Date would round the timestamp and break keyset paging.
const createdAtText = sql<string>`to_char(${auditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const [at, id] = z
      .tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), z.uuid()])
      .parse(parsed);
    return { at, id };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

/** The household's audit log, newest first (keyset pages; the cursor is opaque). Owners only. */
export async function listAudit(
  ctx: ServiceCtx,
  rawOpts: z.input<typeof listAuditSchema> = {},
): Promise<AuditPage> {
  assertOwner(ctx);
  const opts = parseInput(listAuditSchema, rawOpts);
  const limit = Math.min(opts.limit ?? DEFAULT_AUDIT_PAGE, MAX_AUDIT_PAGE);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select({
        id: auditLog.id,
        userId: auditLog.userId,
        actor: auditLog.actor,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        credential: auditLog.credential,
        createdAt: auditLog.createdAt,
        at: createdAtText,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.householdId, ctx.householdId),
          cursor
            ? or(
                sql`${auditLog.createdAt} < ${cursor.at}::timestamptz`,
                and(
                  sql`${auditLog.createdAt} = ${cursor.at}::timestamptz`,
                  lt(auditLog.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        userId: r.userId,
        actor: r.actor as AuditActor,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        credential: r.credential,
        createdAt: r.createdAt,
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.at, last.id])).toString('base64url')
          : null,
    };
  });
}
