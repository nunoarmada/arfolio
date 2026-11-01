import { and, desc, eq, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import type { NotificationKind } from './notification-links.js';
import {
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';

const { connection, notification, notificationRead, organization } = schema;

const DAY_MS = 86_400_000;
/** Consents ending within this many days produce a warning. */
export const CONSENT_WARNING_DAYS = 7;

type NotificationBase = {
  householdId: string;
  payload: Record<string, unknown>;
  /** Makes the notification idempotent per household. */
  dedupeKey: string;
};

/**
 * `push_test` ("send test notification", only ever pushed) must be addressed to one user: a null
 * user would send the test to every member's devices, so the type demands `userId` for it.
 */
export type NotificationInput = NotificationBase &
  (
    | {
        /** Null means every member of the household. */
        userId?: string | null;
        kind: Exclude<NotificationKind, 'push_test'>;
      }
    | { userId: string; kind: 'push_test' }
  );

/** Inserts an in-app notification unless one with the same dedupe key exists. True when created. */
export async function createNotificationInTx(tx: Tx, input: NotificationInput): Promise<boolean> {
  // Also enforced at runtime: callers outside the type system (casts, JS) must not broadcast it.
  if (input.kind === 'push_test' && !input.userId) {
    throw new Error('A push_test notification must be addressed to a user');
  }
  const created = await tx
    .insert(notification)
    .values({
      householdId: input.householdId,
      userId: input.userId ?? null,
      kind: input.kind,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notification.id });
  return created.length > 0;
}

/** One key per consent period: a renewed consent that lapses again must notify again. */
export const consentExpiredKey = (
  connectionId: string,
  consentExpiresAt: Date | null,
  detectedAt: Date,
): string => `consent-expired:${connectionId}:${isoDay(consentExpiresAt ?? detectedAt)}`;

export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Daily job body. Active Enable Banking connections whose consent ends within 7 days get one
 * "expiring" notification per expiry date; consents already past are marked expired (so no
 * further provider calls are made) with a single "expired" notification. Runs over every
 * household, each in its own transaction.
 */
export async function notifyExpiringConsents(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ expiring: number; expired: number }> {
  const now = opts.now ?? new Date();
  const horizon = new Date(now.getTime() + CONSENT_WARNING_DAYS * DAY_MS);
  const households = await db.select({ id: organization.id }).from(organization);
  const totals = { expiring: 0, expired: 0 };
  for (const { id: householdId } of households) {
    await withHousehold(db, householdId, async (tx) => {
      const rows = await tx
        .select({
          id: connection.id,
          displayName: connection.displayName,
          consentExpiresAt: connection.consentExpiresAt,
        })
        .from(connection)
        .where(
          and(
            eq(connection.householdId, householdId),
            eq(connection.provider, 'enablebanking'),
            eq(connection.status, 'active'),
            lte(connection.consentExpiresAt, horizon),
          ),
        );
      for (const row of rows) {
        const expiresAt = row.consentExpiresAt!;
        const payload = {
          connectionId: row.id,
          displayName: row.displayName,
          expiresAt: expiresAt.toISOString(),
        };
        if (expiresAt <= now) {
          await tx
            .update(connection)
            .set({
              status: 'expired',
              nextSyncAt: null,
              lastErrorCode: 'consent_expired',
              lastErrorMessage: 'The bank consent has expired; reconnect to resume syncing',
            })
            .where(eq(connection.id, row.id));
          const created = await createNotificationInTx(tx, {
            householdId,
            kind: 'consent_expired',
            payload,
            dedupeKey: consentExpiredKey(row.id, expiresAt, now),
          });
          if (created) totals.expired += 1;
        } else {
          const created = await createNotificationInTx(tx, {
            householdId,
            kind: 'consent_expiring',
            payload,
            dedupeKey: `consent-expiring:${row.id}:${isoDay(expiresAt)}`,
          });
          if (created) totals.expiring += 1;
        }
      }
    });
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// Reading (per-user read state in `notification_read`; any role, viewers included)

export type NotificationRow = {
  id: string;
  /** Never `push_test` (see `visibleTo`). */
  kind: Exclude<NotificationKind, 'push_test'>;
  payload: Record<string, unknown>;
  createdAt: Date;
  /** Whether the current user has read it. */
  read: boolean;
};

export type NotificationPage = { items: NotificationRow[]; nextCursor: string | null };

const DEFAULT_NOTIFICATION_PAGE = 20;
const MAX_NOTIFICATION_PAGE = 100;

const listNotificationsSchema = z.strictObject({
  limit: z.number().int().min(1).optional(),
  cursor: z.string().max(200).optional(),
});

/**
 * Household-wide rows (`user_id` null) and the ones addressed to this user, except `push_test`:
 * that kind only exists to be pushed, it has no place in the in-app list or the unread count.
 */
const visibleTo = (ctx: ServiceCtx): SQL | undefined =>
  and(
    eq(notification.householdId, ctx.householdId),
    ne(notification.kind, 'push_test'),
    or(isNull(notification.userId), eq(notification.userId, ctx.userId)),
  );

const readByUser = (ctx: ServiceCtx): SQL | undefined =>
  and(
    eq(notificationRead.notificationId, notification.id),
    eq(notificationRead.householdId, notification.householdId),
    eq(notificationRead.userId, ctx.userId),
  );

// Microsecond text, because a JS Date would round the timestamp and break keyset paging.
const createdAtText = sql<string>`to_char(${notification.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function decodeNotificationCursor(cursor: string): { at: string; id: string } {
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

/** The user's notifications, newest first (keyset pages; the cursor is opaque). */
export async function listNotifications(
  ctx: ServiceCtx,
  rawOpts: z.input<typeof listNotificationsSchema> = {},
): Promise<NotificationPage> {
  const opts = parseInput(listNotificationsSchema, rawOpts);
  const limit = Math.min(opts.limit ?? DEFAULT_NOTIFICATION_PAGE, MAX_NOTIFICATION_PAGE);
  const cursor = opts.cursor ? decodeNotificationCursor(opts.cursor) : undefined;
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select({
        id: notification.id,
        kind: notification.kind,
        payload: notification.payload,
        createdAt: notification.createdAt,
        at: createdAtText,
        readAt: notificationRead.readAt,
      })
      .from(notification)
      .leftJoin(notificationRead, readByUser(ctx))
      .where(
        and(
          visibleTo(ctx),
          cursor
            ? or(
                sql`${notification.createdAt} < ${cursor.at}::timestamptz`,
                and(
                  sql`${notification.createdAt} = ${cursor.at}::timestamptz`,
                  lt(notification.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(notification.createdAt), desc(notification.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind as NotificationRow['kind'],
        payload: r.payload,
        createdAt: r.createdAt,
        read: r.readAt !== null,
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.at, last.id])).toString('base64url')
          : null,
    };
  });
}

export async function unreadNotificationCount(ctx: ServiceCtx): Promise<number> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .leftJoin(notificationRead, readByUser(ctx))
      .where(and(visibleTo(ctx), isNull(notificationRead.notificationId)));
    return row?.n ?? 0;
  });
}

/** Marks one notification read for this user. Idempotent; not found when the user cannot see it. */
export async function markNotificationRead(ctx: ServiceCtx, id: string): Promise<void> {
  assertUuid(id, 'Notification');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select({ id: notification.id })
      .from(notification)
      .where(and(visibleTo(ctx), eq(notification.id, id)));
    if (!row) throw new NotFoundError('Notification');
    await tx
      .insert(notificationRead)
      .values({ notificationId: id, userId: ctx.userId, householdId: ctx.householdId })
      .onConflictDoNothing();
  });
}

/** Marks everything this user can see as read (for them only). */
export async function markAllNotificationsRead(ctx: ServiceCtx): Promise<{ marked: number }> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const unread = await tx
      .select({ id: notification.id })
      .from(notification)
      .leftJoin(notificationRead, readByUser(ctx))
      .where(and(visibleTo(ctx), isNull(notificationRead.notificationId)));
    if (unread.length === 0) return { marked: 0 };
    await tx
      .insert(notificationRead)
      .values(
        unread.map((r) => ({
          notificationId: r.id,
          userId: ctx.userId,
          householdId: ctx.householdId,
        })),
      )
      .onConflictDoNothing();
    return { marked: unread.length };
  });
}
