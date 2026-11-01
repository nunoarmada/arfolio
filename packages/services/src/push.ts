import { and, desc, eq, sql } from 'drizzle-orm';
import webpush from 'web-push';
import { z } from 'zod';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { EnvError } from '@arfolio/core';
import { decryptSecret, encryptSecret } from '@arfolio/core/server';
import {
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { createNotificationInTx } from './notifications.js';

const { pushSubscription, instanceSecret } = schema;

const VAPID_SECRET = 'vapid';
const VAPID_AAD = 'instance:vapid';
/** The subject used when neither VAPID_SUBJECT nor an https APP_URL is available (worker env). */
export const DEFAULT_VAPID_SUBJECT = 'mailto:no-reply@localhost';

export type VapidDeps = {
  db: Db;
  /** 32-byte key from `loadEncryptionKey`. */
  encryptionKey: Buffer;
  /** VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: used only when BOTH are set. */
  publicKey?: string | undefined;
  privateKey?: string | undefined;
  /** VAPID_SUBJECT (`mailto:` or `https:`). */
  subject?: string | undefined;
  /** APP_URL, the subject when it is https and no explicit subject is set. */
  appUrl?: string | undefined;
};

export type VapidKeys = { publicKey: string; privateKey: string; subject: string };

function vapidSubject(deps: VapidDeps): string {
  if (deps.subject !== undefined) {
    if (!/^mailto:.+@.+/.test(deps.subject) && !/^https:\/\/.+/.test(deps.subject)) {
      throw new EnvError(['VAPID_SUBJECT']);
    }
    return deps.subject;
  }
  if (deps.appUrl?.startsWith('https://')) return deps.appUrl;
  return DEFAULT_VAPID_SUBJECT;
}

type StoredVapid = { publicKey: string; privateKey: string };

/**
 * The installation's VAPID key pair (base64url: 65-byte uncompressed public key, 32-byte private
 * key, the format Web Push libraries expect). Environment wins when both keys are set (exactly one
 * is an EnvError). Otherwise a pair is generated once and kept in `instance_secret` as a single
 * row (`vapid`: public key plain, private key AES-GCM encrypted with AAD `instance:vapid`); the
 * single-row `insert ... on conflict do nothing` then read makes concurrent first calls (web and
 * worker starting together) all end up with the same pair.
 */
export async function vapidKeys(deps: VapidDeps): Promise<VapidKeys> {
  const { publicKey, privateKey } = deps;
  if ((publicKey === undefined) !== (privateKey === undefined)) {
    throw new EnvError([publicKey === undefined ? 'VAPID_PUBLIC_KEY' : 'VAPID_PRIVATE_KEY']);
  }
  const subject = vapidSubject(deps);
  if (publicKey !== undefined && privateKey !== undefined)
    return { publicKey, privateKey, subject };

  const read = async (): Promise<StoredVapid | undefined> => {
    const [row] = await deps.db
      .select({ value: instanceSecret.value })
      .from(instanceSecret)
      .where(eq(instanceSecret.name, VAPID_SECRET));
    return row ? (JSON.parse(row.value) as StoredVapid) : undefined;
  };
  let stored = await read();
  if (!stored) {
    const fresh = webpush.generateVAPIDKeys();
    const value: StoredVapid = {
      publicKey: fresh.publicKey,
      privateKey: encryptSecret(fresh.privateKey, deps.encryptionKey, VAPID_AAD),
    };
    await deps.db
      .insert(instanceSecret)
      .values({ name: VAPID_SECRET, value: JSON.stringify(value) })
      .onConflictDoNothing();
    stored = await read();
    if (!stored) throw new Error('VAPID keys could not be stored');
  }
  return {
    publicKey: stored.publicKey,
    privateKey: decryptSecret(stored.privateKey, deps.encryptionKey, VAPID_AAD),
    subject,
  };
}

// --- subscriptions --------------------------------------------------------------------------

const MAX_ENDPOINT = 2048;
const MAX_USER_AGENT = 256;

/**
 * Host suffixes of the browsers' push services (FCM for Chrome/Edge/Android, Mozilla autopush,
 * WNS, APNs web push). A subscription endpoint is a URL the server later POSTs to, so anything
 * else would be a request to an arbitrary https host chosen by any authenticated user (SSRF).
 */
export const PUSH_HOST_SUFFIXES: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

/**
 * True for an https URL on the default port (none or 443), without credentials, whose host is one
 * of the push-service suffixes or `extraSuffixes` (PUSH_ALLOWED_HOSTS, for self-hosted push
 * services) or a subdomain of one. The suffix match is on a label boundary, trailing-dot hosts and
 * IP literals never match. Task 3's sender calls this again at send time.
 */
export function isPushEndpoint(value: string, extraSuffixes: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return false;
  const host = url.hostname;
  if (host.endsWith('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return [...PUSH_HOST_SUFFIXES, ...extraSuffixes].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** The URL as the platform normalises it (lower-case host, default port dropped, escapes). */
const normaliseEndpoint = (value: string): string => {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
};

const base64urlBytes = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url')
    .refine((v) => Buffer.from(v, 'base64url').length === bytes, `expected ${bytes} bytes`);

const subscribeSchema = (allowedHosts: readonly string[]) =>
  z.object({
    endpoint: z
      .string()
      .max(MAX_ENDPOINT)
      .refine(
        (v) => isPushEndpoint(v, allowedHosts),
        'expected an https endpoint of a push service',
      ),
    keys: z.object({ p256dh: base64urlBytes(65), auth: base64urlBytes(16) }),
    userAgent: z
      .string()
      .optional()
      .transform((ua) => ua?.slice(0, MAX_USER_AGENT)),
  });

export type PushSubscriptionInput = z.input<ReturnType<typeof subscribeSchema>>;

/** A device as the settings UI sees it: never the endpoint or the keys. */
export type PushDevice = {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  failureCount: number;
};

/**
 * Registers this browser for the caller. Viewers may (it is their own device). The endpoint is
 * unique across households and belongs to whoever subscribed last: a subscription of another
 * household is released first through claim_push_endpoint() (the one security-definer path across
 * RLS, see migration 0026), one of another user in this household is taken over by the upsert.
 */
export async function subscribePush(
  ctx: ServiceCtx,
  rawInput: PushSubscriptionInput,
  opts: { allowedHosts?: readonly string[] } = {},
): Promise<{ id: string }> {
  const parsed = parseInput(subscribeSchema(opts.allowedHosts ?? []), rawInput);
  // Store what the sender will actually request, so the same device cannot hide behind a second
  // spelling of its endpoint (and the unique index keeps meaning "one row per device").
  const input = { ...parsed, endpoint: normaliseEndpoint(parsed.endpoint) };
  if (input.endpoint.length > MAX_ENDPOINT) {
    throw new ValidationError('Invalid input (endpoint: too long)', [
      { path: ['endpoint'], message: 'too long' },
    ]);
  }
  const run = () =>
    withHousehold(ctx.db, ctx.householdId, async (tx) => {
      await tx.execute(sql`select claim_push_endpoint(${input.endpoint})`);
      const [row] = await tx
        .insert(pushSubscription)
        .values({
          householdId: ctx.householdId,
          userId: ctx.userId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
        })
        .onConflictDoUpdate({
          target: pushSubscription.endpoint,
          set: {
            userId: ctx.userId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            userAgent: input.userAgent ?? null,
            failureCount: 0,
            nextAttemptAt: null,
          },
        })
        .returning({ id: pushSubscription.id });
      return { id: row!.id };
    });
  try {
    return await run();
  } catch (err) {
    // Two households claiming the same endpoint at once: neither claim saw the other's uncommitted
    // row, so the loser hits the unique index (23505) or, once the winner commits, RLS on the
    // conflicting row (42501). Retrying once makes its claim see and release the winner's row.
    if (!isSubscribeRace(err)) throw err;
    return run();
  }
}

function isSubscribeRace(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === '23505' || code === '42501';
}

/** Removes one of the caller's own devices, by device id or by the browser's own endpoint. */
export async function unsubscribePush(
  ctx: ServiceCtx,
  target: { id: string } | { endpoint: string },
): Promise<void> {
  let which;
  if ('id' in target) {
    assertUuid(target.id, 'Push device');
    which = eq(pushSubscription.id, target.id);
  } else {
    which = eq(pushSubscription.endpoint, normaliseEndpoint(String(target.endpoint)));
  }
  const removed = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .delete(pushSubscription)
      .where(and(which, eq(pushSubscription.userId, ctx.userId)))
      .returning({ id: pushSubscription.id }),
  );
  if (removed.length === 0) throw new NotFoundError('Push device');
}

/** The caller's own devices, newest first. */
export async function listMyPushDevices(ctx: ServiceCtx): Promise<PushDevice[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({
        id: pushSubscription.id,
        userAgent: pushSubscription.userAgent,
        createdAt: pushSubscription.createdAt,
        lastSuccessAt: pushSubscription.lastSuccessAt,
        failureCount: pushSubscription.failureCount,
      })
      .from(pushSubscription)
      .where(eq(pushSubscription.userId, ctx.userId))
      .orderBy(desc(pushSubscription.createdAt)),
  );
}

/**
 * The caller's own device for this browser endpoint, or null. The settings page uses it to tell
 * which row of the list is "this device" without ever receiving an endpoint.
 */
export async function findMyPushDevice(
  ctx: ServiceCtx,
  endpoint: string,
): Promise<{ id: string } | null> {
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ id: pushSubscription.id })
      .from(pushSubscription)
      .where(
        and(
          eq(pushSubscription.endpoint, normaliseEndpoint(String(endpoint))),
          eq(pushSubscription.userId, ctx.userId),
        ),
      ),
  );
  return row ?? null;
}

const MINUTE_MS = 60_000;

/**
 * "Send a test notification": a `push_test` notification addressed to the caller only (never in
 * the in-app list). The delivery job pushes it to all the caller's devices, within a minute. One
 * per user per minute: a repeat inside the same minute is absorbed by the dedupe key and reports
 * `created: false`. Viewers may (it is their own devices).
 */
export async function sendTestPush(
  ctx: ServiceCtx,
  opts: { now?: Date } = {},
): Promise<{ created: boolean }> {
  const bucket = Math.floor((opts.now ?? new Date()).getTime() / MINUTE_MS);
  const created = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    createNotificationInTx(tx, {
      householdId: ctx.householdId,
      userId: ctx.userId,
      kind: 'push_test',
      payload: {},
      dedupeKey: `push-test:${ctx.userId}:${bucket}`,
    }),
  );
  return { created };
}
