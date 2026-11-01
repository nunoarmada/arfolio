import { and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import webpush from 'web-push';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { isPushEndpoint, type VapidKeys } from './push.js';
import { payloadId, pushCopy, pushUrl, type PushKind } from './push-copy.js';

const { notification, pushSubscription, member, householdSettings, budget, organization } = schema;

const HOUR_MS = 3_600_000;
/** A notification older than this is marked pushed without being sent (no storm after an outage). */
export const PUSH_MAX_AGE_MS = 24 * HOUR_MS;
/** The failure that reaches this count deletes the subscription. */
export const PUSH_FAILURE_LIMIT = 10;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * HOUR_MS;
const SEND_CONCURRENCY = 8;
/** Hard ceiling for one send, on top of the socket timeout. */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

export type PushPayload = { title: string; body: string; url: string; tag: string };
export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Sends one encrypted push. Resolves with the push service's status; throws on network errors. */
export type PushSender = (
  target: PushTarget,
  payload: PushPayload,
  vapid: VapidKeys,
) => Promise<{ statusCode: number }>;

export type PushDeliveryDeps = {
  db: Db;
  vapid: VapidKeys;
  /** PUSH_ALLOWED_HOSTS: extra push-service host suffixes, checked again before every send. */
  allowedHosts?: readonly string[] | undefined;
};
export type PushDeliveryResult = {
  /** Notifications taken by this run (sent or not). */
  claimed: number;
  /** Notifications past the 24 h window, marked pushed without sending. */
  expired: number;
  sent: number;
  failed: number;
  /** Devices whose send was refused with 401/403 (VAPID keys or subject): not counted as failures. */
  rejected: number;
  /** Devices deleted because their stored endpoint is not on the push allowlist (also in `removed`). */
  invalid: number;
  /** Subscriptions deleted (gone, repeatedly failing, or an endpoint that is not a push service). */
  removed: number;
};

/** The real sender: `web-push` (aes128gcm, TTL 24 h, urgency normal) with a 10 s timeout. */
export function createWebPushSender(): PushSender {
  return async (target, payload, vapid) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('push send timed out')), PUSH_SEND_TIMEOUT_MS);
    });
    try {
      const send = webpush
        .sendNotification(target, JSON.stringify(payload), {
          TTL: PUSH_MAX_AGE_MS / 1000,
          urgency: 'normal',
          timeout: PUSH_SEND_TIMEOUT_MS,
          vapidDetails: vapid,
        })
        .then((r) => ({ statusCode: r.statusCode }))
        // A rejection by the push service is an answer (404/410/…), not a transport failure.
        .catch((err: unknown) => {
          const statusCode = (err as { statusCode?: unknown }).statusCode;
          if (typeof statusCode === 'number') return { statusCode };
          throw err;
        });
      return await Promise.race([send, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

type Claimed = {
  id: string;
  userId: string | null;
  kind: PushKind;
  payload: Record<string, unknown>;
};

type Device = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
  nextAttemptAt: Date | null;
};

type Outcome =
  | { kind: 'sent' }
  | { kind: 'gone' }
  | { kind: 'failed' }
  | { kind: 'rejected' }
  | { kind: 'invalid' };

const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

/**
 * Delivers the notifications that have not been pushed yet (`pushed_at` null, newest 24 h only).
 *
 * At most once per subscription: a run first CLAIMS up to `batch` notifications in one transaction
 * (`for update skip locked`, so concurrent runs take disjoint sets) and sets `pushed_at` in that same
 * transaction, and only then sends, after the commit. A notification is therefore handed to exactly
 * one run, ever. The price is accepted and deliberate: a crash between the claim and the sends loses
 * that push (the in-app notification is still there), because a duplicate lock-screen alert for a
 * financial warning is worse than a missed one. A failed send is not retried for the same
 * notification either; the backoff only keeps the failing device from receiving the next ones.
 *
 * Recipients are resolved per household at send time through the `member` table (a user-scoped
 * notification goes to that user's devices, a household-wide one to every current member's, viewers
 * included), so a stale subscription of someone who is no longer a member never receives anything.
 * Each device is re-checked against the push-service allowlist before it is called. Each device is
 * handled sequentially for the notifications of this run and stops at its first failure, so a run
 * counts at most one failure per device.
 */
export async function deliverPendingPush(
  deps: PushDeliveryDeps,
  opts: { now: Date; sender: PushSender; batch: number },
): Promise<PushDeliveryResult> {
  const result: PushDeliveryResult = {
    claimed: 0,
    expired: 0,
    sent: 0,
    failed: 0,
    rejected: 0,
    invalid: 0,
    removed: 0,
  };
  // `notification` has row-level security, so there is no cross-household view of "unpushed":
  // each household is claimed in its own transaction.
  const households = await deps.db.select({ id: organization.id }).from(organization);
  for (const { id } of households) await deliverHousehold(deps, id, opts, result);
  return result;
}

async function deliverHousehold(
  deps: PushDeliveryDeps,
  householdId: string,
  opts: { now: Date; sender: PushSender; batch: number },
  result: PushDeliveryResult,
): Promise<void> {
  const { now, sender } = opts;
  const cutoff = new Date(now.getTime() - PUSH_MAX_AGE_MS);

  const claim = await withHousehold(deps.db, householdId, async (tx) => {
    const expired = await tx
      .update(notification)
      .set({ pushedAt: now })
      .where(
        and(
          eq(notification.householdId, householdId),
          isNull(notification.pushedAt),
          lte(notification.createdAt, cutoff),
        ),
      )
      .returning({ id: notification.id });
    const rows = await tx
      .select({
        id: notification.id,
        userId: notification.userId,
        kind: notification.kind,
        payload: notification.payload,
      })
      .from(notification)
      .where(
        and(
          eq(notification.householdId, householdId),
          isNull(notification.pushedAt),
          gt(notification.createdAt, cutoff),
        ),
      )
      .orderBy(asc(notification.createdAt))
      .limit(opts.batch)
      .for('update', { skipLocked: true });
    const items = rows as Claimed[]; // `kind` is text in the table, a PushKind by construction
    if (items.length === 0) {
      return {
        expired: expired.length,
        items,
        locale: 'en',
        devices: [] as Device[],
        budgets: new Map<string, { startMonth: string }>(),
      };
    }
    await tx
      .update(notification)
      .set({ pushedAt: now })
      .where(
        inArray(
          notification.id,
          items.map((n) => n.id),
        ),
      );

    const budgetIds = [
      ...new Set(
        items.map((n) => payloadId(n.payload.budgetId)).filter((v): v is string => v !== null),
      ),
    ];
    const [settings] = await tx
      .select({ locale: householdSettings.locale })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    // The join on `member` is the recipient rule: only people who are members right now.
    const devices: Device[] = await tx
      .select({
        id: pushSubscription.id,
        userId: pushSubscription.userId,
        endpoint: pushSubscription.endpoint,
        p256dh: pushSubscription.p256dh,
        auth: pushSubscription.auth,
        failureCount: pushSubscription.failureCount,
        nextAttemptAt: pushSubscription.nextAttemptAt,
      })
      .from(pushSubscription)
      .innerJoin(
        member,
        and(
          eq(member.organizationId, pushSubscription.householdId),
          eq(member.userId, pushSubscription.userId),
        ),
      )
      .where(eq(pushSubscription.householdId, householdId));
    const budgets = budgetIds.length
      ? await tx
          .select({ id: budget.id, startMonth: budget.startMonth })
          .from(budget)
          .where(and(eq(budget.householdId, householdId), inArray(budget.id, budgetIds)))
      : [];
    return {
      expired: expired.length,
      items,
      locale: settings?.locale ?? 'en',
      devices,
      budgets: new Map(budgets.map((b) => [b.id, { startMonth: b.startMonth }])),
    };
  });
  result.expired += claim.expired;
  result.claimed += claim.items.length;
  const { items, locale, devices, budgets } = claim;
  if (items.length === 0) return;

  const payloads = new Map<string, PushPayload>(
    items.map((n) => [
      n.id,
      { ...pushCopy(n.kind, locale), url: pushUrl(n.kind, n.payload, { budgets }), tag: n.id },
    ]),
  );

  // Devices in backoff skip this run's notifications for good (not retried later).
  const eligible = devices.filter((d) => d.nextAttemptAt === null || d.nextAttemptAt <= now);
  const work = eligible
    .map((device) => ({
      device,
      payloads: items
        .filter((n) => n.userId === null || n.userId === device.userId)
        .map((n) => payloads.get(n.id)!),
    }))
    .filter((w) => w.payloads.length > 0);

  const outcomes = new Map<string, Outcome>();
  for (let i = 0; i < work.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      work.slice(i, i + SEND_CONCURRENCY).map(async ({ device, payloads: list }) => {
        outcomes.set(device.id, await sendToDevice(deps, device, list, sender));
      }),
    );
  }

  const gone: string[] = [];
  const ok: string[] = [];
  const failed: Device[] = [];
  for (const { device } of work) {
    const outcome = outcomes.get(device.id)!;
    if (outcome.kind === 'sent') ok.push(device.id);
    else if (outcome.kind === 'rejected') result.rejected += 1;
    else if (outcome.kind === 'invalid') {
      result.invalid += 1;
      gone.push(device.id);
    } else if (outcome.kind === 'failed') failed.push(device);
    else gone.push(device.id);
  }
  const exhausted = failed.filter((d) => d.failureCount + 1 >= PUSH_FAILURE_LIMIT);
  const deletions = [...gone, ...exhausted.map((d) => d.id)];
  result.sent += ok.length;
  result.failed += failed.length;
  result.removed += deletions.length;
  if (deletions.length + ok.length + failed.length === 0) return;

  await withHousehold(deps.db, householdId, async (tx) => {
    if (deletions.length) {
      await tx
        .delete(pushSubscription)
        .where(
          and(
            eq(pushSubscription.householdId, householdId),
            inArray(pushSubscription.id, deletions),
          ),
        );
    }
    if (ok.length) {
      await tx
        .update(pushSubscription)
        .set({ failureCount: 0, nextAttemptAt: null, lastSuccessAt: now })
        .where(
          and(eq(pushSubscription.householdId, householdId), inArray(pushSubscription.id, ok)),
        );
    }
    for (const d of failed.filter((f) => !exhausted.includes(f))) {
      const failures = d.failureCount + 1;
      await tx
        .update(pushSubscription)
        .set({
          failureCount: failures,
          nextAttemptAt: new Date(now.getTime() + backoffMs(failures)),
        })
        .where(and(eq(pushSubscription.householdId, householdId), eq(pushSubscription.id, d.id)));
    }
  });
}

/** One device, its notifications in order; stops at the first one that does not succeed. */
async function sendToDevice(
  deps: PushDeliveryDeps,
  device: Device,
  payloads: PushPayload[],
  sender: PushSender,
): Promise<Outcome> {
  // The stored endpoint was valid when it was saved; the allowlist may have changed since, and the
  // row could have been written by anything with database access. Never call an unchecked URL.
  if (!isPushEndpoint(device.endpoint, deps.allowedHosts ?? [])) return { kind: 'invalid' };
  const target: PushTarget = {
    endpoint: device.endpoint,
    keys: { p256dh: device.p256dh, auth: device.auth },
  };
  for (const payload of payloads) {
    let statusCode: number;
    try {
      ({ statusCode } = await sender(target, payload, deps.vapid));
    } catch {
      return { kind: 'failed' };
    }
    if (statusCode === 404 || statusCode === 410) return { kind: 'gone' };
    // The push service refuses OUR identity (VAPID keys/subject), not this device: an instance-wide
    // fault that must not wear every subscription down to deletion.
    if (statusCode === 401 || statusCode === 403) return { kind: 'rejected' };
    if (statusCode < 200 || statusCode >= 300) return { kind: 'failed' };
  }
  return { kind: 'sent' };
}
