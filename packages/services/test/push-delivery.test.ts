import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  deliverPendingPush,
  NOTIFICATION_KINDS,
  PUSH_FAILURE_LIMIT,
  pushCopy,
  type PushPayload,
  type PushSender,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { pushSubscription, notification, member } = schema;
const HOUR = 3_600_000;
const now = new Date('2026-10-23T10:00:00.000Z');
const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.test' };
const BUDGET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const CONN = '44444444-4444-4444-8444-444444444444';

type Call = { endpoint: string; payload: PushPayload };

/** A sender that records every call and answers with the status chosen per endpoint. */
function recordingSender(status: (endpoint: string) => number = () => 201) {
  const calls: Call[] = [];
  const sender: PushSender = async (sub, payload) => {
    calls.push({ endpoint: sub.endpoint, payload });
    return { statusCode: status(sub.endpoint) };
  };
  return { calls, sender };
}

describe('deliverPendingPush', () => {
  let t: ServicesTestDb;
  const key = () => ({
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  });
  const deps = () => ({ db: t.db, vapid: VAPID });
  const ep = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${randomUUID()}`;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** A user that is (or, with `member: false`, is no longer) a member of the household. */
  async function addUser(
    ctx: ServiceCtx,
    name: string,
    opts: { role?: string; member?: boolean } = {},
  ) {
    const id = `${name}-${randomUUID()}`;
    await t.owner.insert(schema.user).values({ id, name: id, email: `${id}@example.test` });
    if (opts.member !== false) {
      await t.owner.insert(member).values({
        id: randomUUID(),
        organizationId: ctx.householdId,
        userId: id,
        role: opts.role ?? 'member',
        createdAt: new Date(),
      });
    }
    return id;
  }

  async function addDevice(ctx: ServiceCtx, userId: string, endpoint = ep('dev')) {
    await t.owner.insert(pushSubscription).values({
      householdId: ctx.householdId,
      userId,
      endpoint,
      ...key(),
    });
    return endpoint;
  }

  async function notify(
    ctx: ServiceCtx,
    opts: {
      userId?: string | null;
      kind?: (typeof notification.$inferInsert)['kind'];
      payload?: Record<string, unknown>;
      createdAt?: Date;
    } = {},
  ) {
    const [row] = await t.owner
      .insert(notification)
      .values({
        householdId: ctx.householdId,
        userId: opts.userId ?? null,
        kind: opts.kind ?? 'sync_failing',
        payload: opts.payload ?? {},
        dedupeKey: randomUUID(),
        createdAt: opts.createdAt ?? new Date(now.getTime() - HOUR),
      })
      .returning({ id: notification.id });
    return row!.id;
  }

  const sub = async (endpoint: string) =>
    (
      await t.owner.select().from(pushSubscription).where(eq(pushSubscription.endpoint, endpoint))
    )[0];
  const pushedAt = async (id: string) =>
    (await t.owner.select().from(notification).where(eq(notification.id, id)))[0]!.pushedAt;

  /** Isolated household so that every test only sees its own unpushed notifications. */
  const fresh = async (locale?: string) => {
    const ctx = await t.household(locale ? { locale } : {});
    // other tests' leftovers must not be delivered into this test's sender
    await t.owner.update(notification).set({ pushedAt: now });
    return ctx;
  };

  describe('recipients', () => {
    it('sends a user-scoped notification only to that user, only while a member', async () => {
      const ctx = await fresh();
      const alice = await addUser(ctx, 'alice');
      const bob = await addUser(ctx, 'bob');
      const gone = await addUser(ctx, 'gone', { member: false });
      const aliceDevice = await addDevice(ctx, alice);
      await addDevice(ctx, bob);
      await addDevice(ctx, gone);
      const id = await notify(ctx, { userId: alice });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.endpoint)).toEqual([aliceDevice]);
      expect(calls[0]!.payload.tag).toBe(id);
      expect(await pushedAt(id)).not.toBeNull();
    });

    it('does not send a user-scoped notification to a user who left the household', async () => {
      const ctx = await fresh();
      const gone = await addUser(ctx, 'gone', { member: false });
      await addDevice(ctx, gone);
      const id = await notify(ctx, { userId: gone });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls).toEqual([]);
      expect(await pushedAt(id)).not.toBeNull();
    });

    it('sends a household-wide notification to every current member, viewers included, never to another household', async () => {
      const ctx = await fresh();
      const other = await t.household();
      const owner = await addUser(ctx, 'owner', { role: 'owner' });
      const viewer = await addUser(ctx, 'viewer', { role: 'viewer' });
      const gone = await addUser(ctx, 'gone', { member: false });
      const outsider = await addUser(other, 'outsider');
      const wanted = [await addDevice(ctx, owner), await addDevice(ctx, viewer)];
      await addDevice(ctx, gone);
      await addDevice(other, outsider);
      await notify(ctx, { userId: null });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.endpoint).sort()).toEqual(wanted.sort());
    });

    it('never sends one household’s notification to a device of another household', async () => {
      const a = await fresh();
      const b = await t.household();
      const shared = await addUser(a, 'shared');
      await t.owner.insert(member).values({
        id: randomUUID(),
        organizationId: b.householdId,
        userId: shared,
        role: 'member',
        createdAt: new Date(),
      });
      const deviceOfB = await addDevice(b, shared);
      await notify(a, { userId: shared });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.endpoint)).not.toContain(deviceOfB);
    });
  });

  describe('at most once per subscription', () => {
    it('concurrent runs never push the same notification to the same device twice', async () => {
      const ctx = await fresh();
      const users = await Promise.all([addUser(ctx, 'u1'), addUser(ctx, 'u2'), addUser(ctx, 'u3')]);
      for (const u of users) await addDevice(ctx, u);
      for (let i = 0; i < 6; i += 1) await notify(ctx);
      const { calls, sender } = recordingSender();

      await Promise.all(
        Array.from({ length: 4 }, () => deliverPendingPush(deps(), { now, sender, batch: 2 })),
      );
      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      const pairs = calls.map((c) => `${c.payload.tag}|${c.endpoint}`);
      expect(new Set(pairs).size).toBe(pairs.length);
      expect(pairs).toHaveLength(6 * 3);
    });

    it('does not push again on a later run', async () => {
      const ctx = await fresh();
      await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      const first = recordingSender();
      await deliverPendingPush(deps(), { now, sender: first.sender, batch: 50 });
      const second = recordingSender();
      await deliverPendingPush(deps(), { now, sender: second.sender, batch: 50 });
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toEqual([]);
    });

    it('claims at most `batch` notifications per run, oldest first', async () => {
      const ctx = await fresh();
      await addDevice(ctx, await addUser(ctx, 'u'));
      const older = await notify(ctx, { createdAt: new Date(now.getTime() - 3 * HOUR) });
      const newer = await notify(ctx, { createdAt: new Date(now.getTime() - HOUR) });
      const { calls, sender } = recordingSender();

      const result = await deliverPendingPush(deps(), { now, sender, batch: 1 });

      expect(calls.map((c) => c.payload.tag)).toEqual([older]);
      expect(await pushedAt(newer)).toBeNull();
      expect(result.claimed).toBe(1);
    });
  });

  describe('24 hour cutoff', () => {
    it('marks older notifications as pushed without sending them', async () => {
      const ctx = await fresh();
      await addDevice(ctx, await addUser(ctx, 'u'));
      const stale = await notify(ctx, { createdAt: new Date(now.getTime() - 25 * HOUR) });
      const recent = await notify(ctx, { createdAt: new Date(now.getTime() - 23 * HOUR) });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.payload.tag)).toEqual([recent]);
      expect(await pushedAt(stale)).not.toBeNull();
    });
  });

  describe('subscription health', () => {
    it('deletes a subscription the push service reports gone (404 and 410)', async () => {
      const ctx = await fresh();
      const u = await addUser(ctx, 'u');
      const e404 = await addDevice(ctx, u);
      const e410 = await addDevice(ctx, u);
      const ok = await addDevice(ctx, u);
      await notify(ctx);
      const { sender } = recordingSender((e) => (e === e404 ? 404 : e === e410 ? 410 : 201));

      const result = await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(await sub(e404)).toBeUndefined();
      expect(await sub(e410)).toBeUndefined();
      expect(await sub(ok)).toBeDefined();
      expect(result).toMatchObject({ sent: 1, removed: 2 });
    });

    it('backs off exponentially on other errors, without retrying the same notification', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      const failing = recordingSender(() => 500);

      await deliverPendingPush(deps(), { now, sender: failing.sender, batch: 50 });
      const first = await sub(e);
      expect(first!.failureCount).toBe(1);
      const firstDelay = first!.nextAttemptAt!.getTime() - now.getTime();
      expect(firstDelay).toBeGreaterThan(0);
      expect(failing.calls).toHaveLength(1);

      // a new notification inside the backoff window is not sent to this device
      await notify(ctx);
      const during = recordingSender();
      await deliverPendingPush(deps(), { now, sender: during.sender, batch: 50 });
      expect(during.calls).toEqual([]);

      // after the window it is sent again, and a second failure doubles the delay
      const later = new Date(first!.nextAttemptAt!.getTime() + 1000);
      await notify(ctx, { createdAt: new Date(later.getTime() - HOUR) });
      await deliverPendingPush(deps(), { now: later, sender: failing.sender, batch: 50 });
      const second = await sub(e);
      expect(second!.failureCount).toBe(2);
      expect(second!.nextAttemptAt!.getTime() - later.getTime()).toBe(firstDelay * 2);
    });

    it('401 and 403 (VAPID rejected) do not count against devices, and are reported once', async () => {
      const ctx = await fresh();
      const u = await addUser(ctx, 'u');
      const a = await addDevice(ctx, u);
      const b = await addDevice(ctx, u);
      await notify(ctx);
      const { sender } = recordingSender((e) => (e === a ? 401 : 403));

      const result = await deliverPendingPush(deps(), { now, sender, batch: 50 });

      for (const e of [a, b]) {
        expect(await sub(e)).toMatchObject({ failureCount: 0, nextAttemptAt: null });
      }
      expect(result).toMatchObject({ rejected: 2, failed: 0, sent: 0, removed: 0 });
    });

    it('counts one failure per run even when several notifications fail for a device', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      await notify(ctx);
      await notify(ctx);
      const failing = recordingSender(() => 503);

      await deliverPendingPush(deps(), { now, sender: failing.sender, batch: 50 });

      expect((await sub(e))!.failureCount).toBe(1);
      expect(failing.calls).toHaveLength(1);
    });

    it('treats a sender that throws (network error, timeout) as a failure', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      const sender: PushSender = async () => {
        throw new Error('socket hang up');
      };

      await expect(deliverPendingPush(deps(), { now, sender, batch: 50 })).resolves.toMatchObject({
        failed: 1,
      });
      expect((await sub(e))!.failureCount).toBe(1);
    });

    it('deletes the subscription on the failure that reaches the limit', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await t.owner
        .update(pushSubscription)
        .set({ failureCount: PUSH_FAILURE_LIMIT - 1 })
        .where(eq(pushSubscription.endpoint, e));
      await notify(ctx);
      const { sender } = recordingSender(() => 500);

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(await sub(e)).toBeUndefined();
    });

    it('resets the failure count and records the success', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await t.owner
        .update(pushSubscription)
        .set({ failureCount: 4, nextAttemptAt: new Date(now.getTime() - 1000) })
        .where(eq(pushSubscription.endpoint, e));
      await notify(ctx);
      const { sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(await sub(e)).toMatchObject({
        failureCount: 0,
        nextAttemptAt: null,
        lastSuccessAt: now,
      });
    });

    it('re-validates the stored endpoint before sending: a bad host is deleted and never called', async () => {
      const ctx = await fresh();
      const u = await addUser(ctx, 'u');
      const bad = await addDevice(ctx, u, 'https://internal.example.test/hook');
      const good = await addDevice(ctx, u);
      await notify(ctx);
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.endpoint)).toEqual([good]);
      expect(await sub(bad)).toBeUndefined();
    });

    it('counts endpoints outside the allowlist as invalid, apart from gone devices', async () => {
      const ctx = await fresh();
      const u = await addUser(ctx, 'u');
      await addDevice(ctx, u, 'https://internal.example.test/hook');
      await addDevice(ctx, u, 'https://other.example.test/hook');
      await addDevice(ctx, u);
      await notify(ctx);
      const { sender } = recordingSender();

      const result = await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(result).toMatchObject({ sent: 1, invalid: 2, removed: 2, rejected: 0 });
    });

    it('does not count a 410 as invalid', async () => {
      const ctx = await fresh();
      await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      const { sender } = recordingSender(() => 410);

      const result = await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(result).toMatchObject({ invalid: 0, removed: 1 });
    });

    it('honours PUSH_ALLOWED_HOSTS at send time', async () => {
      const ctx = await fresh();
      const custom = await addDevice(ctx, await addUser(ctx, 'u'), 'https://up.push.example.org/x');
      await notify(ctx);
      const { calls, sender } = recordingSender();

      await deliverPendingPush(
        { ...deps(), allowedHosts: ['push.example.org'] },
        { now, sender, batch: 50 },
      );

      expect(calls.map((c) => c.endpoint)).toEqual([custom]);
    });

    it('passes the stored keys and the VAPID identity to the sender', async () => {
      const ctx = await fresh();
      const e = await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx);
      const seen: unknown[] = [];
      const sender: PushSender = async (s, _payload, vapid) => {
        seen.push([s, vapid]);
        return { statusCode: 201 };
      };

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      const stored = (await sub(e))!;
      expect(seen).toEqual([
        [{ endpoint: e, keys: { p256dh: stored.p256dh, auth: stored.auth } }, VAPID],
      ]);
    });
  });

  describe('payload', () => {
    const sendOne = async (
      ctx: ServiceCtx,
      kind: (typeof notification.$inferInsert)['kind'],
      payload: Record<string, unknown>,
      userId: string | null = null,
    ) => {
      await addDevice(ctx, await addUser(ctx, 'u'));
      await notify(ctx, { kind, payload, userId });
      const { calls, sender } = recordingSender();
      await deliverPendingPush(deps(), { now, sender, batch: 50 });
      return calls[0]!.payload;
    };

    it('is {title, body, url, tag} with the neutral Portuguese copy for a pt-PT household', async () => {
      const ctx = await fresh('pt-PT');
      const p = await sendOne(ctx, 'budget_line_threshold', {
        budgetId: BUDGET,
        monthIndex: 1,
        threshold: 80,
        planned: 123456,
        actual: 98765,
        lineName: 'Supermercado Pingo Doce',
      });
      expect(Object.keys(p).sort()).toEqual(['body', 'tag', 'title', 'url']);
      expect(p.body).toBe('Uma rubrica do orçamento chegou ao limite.');
    });

    it('is English for an en household', async () => {
      const ctx = await fresh('en');
      const p = await sendOne(ctx, 'budget_line_threshold', { budgetId: BUDGET, monthIndex: 1 });
      expect(p.body).toBe('A budget line has reached its limit.');
    });

    it.each(NOTIFICATION_KINDS)(
      '%s carries no amounts, names or digits in the text, in either language',
      async (kind) => {
        const secrets = ['Netflix Premium', 'Conta Ordenado', 'Supermercado Pingo Doce'];
        for (const locale of ['pt-PT', 'en']) {
          const ctx = await fresh(locale);
          const u = await addUser(ctx, 'u');
          await addDevice(ctx, u);
          await notify(ctx, {
            kind,
            userId: kind === 'push_test' ? u : null,
            payload: {
              budgetId: BUDGET,
              lineId: REC,
              lineName: secrets[2],
              recurringId: REC,
              connectionId: CONN,
              name: secrets[0],
              displayName: secrets[1],
              monthIndex: 2,
              threshold: 80,
              planned: 123456,
              actual: 98765,
              previousAmount: 1299,
              amount: 1599,
              remainingInHub: -45000,
              currency: 'EUR',
              expiresAt: '2026-10-30T00:00:00.000Z',
            },
          });
          const { calls, sender } = recordingSender();
          await deliverPendingPush(deps(), { now, sender, batch: 50 });
          const p = calls[0]!.payload;
          expect(Object.keys(p).sort()).toEqual(['body', 'tag', 'title', 'url']);
          const text = `${p.title} ${p.body}`;
          expect(text).not.toMatch(/\d/);
          expect(text).not.toMatch(/EUR|€/);
          for (const secret of secrets) expect(JSON.stringify(p)).not.toContain(secret);
          expect(p.url).toMatch(/^\/(?!\/)/);
        }
      },
    );

    it('maps each kind to a same-origin page', async () => {
      const ctx = await fresh();
      await t.owner
        .insert(schema.budget)
        .values({
          id: BUDGET,
          householdId: ctx.householdId,
          name: 'B',
          startMonth: '2026-10-01',
          createdBy: 'tester',
          status: 'active',
        })
        .onConflictDoNothing();
      const budgetUrl = (
        await sendOne(ctx, 'budget_line_threshold', { budgetId: BUDGET, monthIndex: 3 })
      ).url;
      expect(budgetUrl).toBe('/budget?month=2026-12');
      expect(
        (await sendOne(ctx, 'budget_unallocated_negative', { budgetId: BUDGET, monthIndex: 1 }))
          .url,
      ).toBe('/budget/transfers?month=2026-10');
      expect((await sendOne(ctx, 'recurring_missed', { recurringId: REC })).url).toBe(
        `/budget/subscriptions#rec-${REC}`,
      );
      expect((await sendOne(ctx, 'recurring_price_change', { recurringId: REC })).url).toBe(
        `/budget/subscriptions?edit=${REC}`,
      );
      expect((await sendOne(ctx, 'sync_failing', { connectionId: CONN })).url).toBe(
        `/connections#conn-${CONN}`,
      );
      const LINE = '55555555-5555-4555-8555-555555555555';
      expect(
        (
          await sendOne(ctx, 'budget_line_threshold', {
            budgetId: BUDGET,
            monthIndex: 1,
            lineId: LINE,
          })
        ).url,
      ).toBe(`/budget?month=2026-10#line-${LINE}`);
    });

    it('never builds a url from a crafted payload id', async () => {
      const ctx = await fresh();
      const p = await sendOne(ctx, 'recurring_missed', { recurringId: 'https://evil.example/x' });
      expect(p.url).toBe('/budget/subscriptions');
      const q = await sendOne(ctx, 'budget_line_threshold', { budgetId: '//evil.example' });
      expect(q.url).toBe('/budget');
    });

    it('sends the push_test notification to its own user with the activation title', async () => {
      const ctx = await fresh('en');
      const u = await addUser(ctx, 'tester');
      const other = await addUser(ctx, 'other');
      const mine = await addDevice(ctx, u);
      await addDevice(ctx, other);
      await notify(ctx, { kind: 'push_test', userId: u });
      const { calls, sender } = recordingSender();

      await deliverPendingPush(deps(), { now, sender, batch: 50 });

      expect(calls.map((c) => c.endpoint)).toEqual([mine]);
      expect(calls[0]!.payload.title).toBe('Notifications are on');
    });
  });
});

describe('pushCopy', () => {
  it('has a title and a body in every language for every kind', () => {
    const kinds = [
      'consent_expiring',
      'consent_expired',
      'sync_failing',
      'recurring_missed',
      'recurring_price_change',
      'budget_line_threshold',
      'budget_unallocated_negative',
      'push_test',
      'ai_report_ready',
    ] as const;
    for (const kind of kinds) {
      for (const locale of ['pt-PT', 'es-ES', 'fr-FR', 'it-IT', 'en']) {
        const c = pushCopy(kind, locale);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.body.length).toBeGreaterThan(0);
      }
    }
    // neutral: no amounts, no figures, no month
    for (const locale of ['pt-PT', 'es-ES', 'fr-FR', 'it-IT', 'en']) {
      const c = pushCopy('ai_report_ready', locale);
      expect(`${c.title} ${c.body}`).not.toMatch(/\d/);
    }
    expect(pushCopy('push_test', 'pt-PT').title).toBe('Notificações ativas');
    expect(pushCopy('push_test', 'es-ES').title).toBe('Notificaciones activas');
    expect(pushCopy('push_test', 'fr').title).toBe('Notifications activées');
    expect(pushCopy('push_test', 'it-IT').title).toBe('Notifiche attive');
    expect(pushCopy('push_test', 'pt-BR').title).toBe('Notificações ativas');
    expect(pushCopy('push_test', 'de').title).toBe('Notifications are on');
  });
});
