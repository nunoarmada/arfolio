import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  addTrading212Connection,
  completeBankConsent,
  linkConnectionAccounts,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notifyExpiringConsents,
  NotFoundError,
  startBankConsent,
  unreadNotificationCount,
  type ServiceCtx,
} from '../src/index.js';
import { createNotificationInTx } from '../src/internal.js';
import { fakeBanking, fakeTrading212, makeDeps } from './connector-fakes.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { connection, notification } = schema;
const DAY = 86_400_000;

describe('consent expiry notifications', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  const now = new Date('2026-10-18T09:00:00.000Z');

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
  });
  afterAll(() => t.close());

  async function bankConnection(ctx: ServiceCtx, expiresAt: Date, link = true) {
    const banking = fakeBanking();
    banking.validUntil = expiresAt.toISOString();
    const deps = makeDeps(banking, undefined);
    await startBankConsent(ctx, deps, { aspspName: 'Test Bank', country: 'PT' });
    const { connectionId } = await completeBankConsent(ctx, deps, {
      state: banking.states[0]!,
      code: 'c',
    });
    if (link) {
      await linkConnectionAccounts(ctx, deps, connectionId, [
        { externalKey: 'key-a', create: { name: 'Acc', type: 'checking' } },
      ]);
    }
    return connectionId;
  }

  const notificationsOf = (ctx: ServiceCtx) =>
    t.owner.select().from(notification).where(eq(notification.householdId, ctx.householdId));

  it('notifies once per expiry for consents ending within 7 days, ignoring later ones', async () => {
    const soon = await bankConnection(a, new Date(now.getTime() + 5 * DAY));
    await bankConnection(a, new Date(now.getTime() + 10 * DAY));

    const first = await notifyExpiringConsents(t.db, { now });
    expect(first).toMatchObject({ expiring: 1, expired: 0 });
    const rows = await notificationsOf(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'consent_expiring',
      userId: null,
      dedupeKey: `consent-expiring:${soon}:2026-10-23`,
    });
    expect(rows[0]!.payload).toMatchObject({
      connectionId: soon,
      expiresAt: '2026-10-23T09:00:00.000Z',
    });
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/session|secret/i);

    // The daily job runs again: same expiry, no second notification.
    await notifyExpiringConsents(t.db, { now: new Date(now.getTime() + DAY) });
    expect(await notificationsOf(a)).toHaveLength(1);
  });

  it('marks a lapsed consent expired and notifies once', async () => {
    const lapsed = await bankConnection(b, new Date(now.getTime() - DAY));
    const result = await notifyExpiringConsents(t.db, { now });
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const [row] = await t.owner.select().from(connection).where(eq(connection.id, lapsed));
    expect(row).toMatchObject({
      status: 'expired',
      nextSyncAt: null,
      lastErrorCode: 'consent_expired',
    });
    const rows = await notificationsOf(b);
    expect(rows.map((r) => [r.kind, r.dedupeKey])).toEqual([
      ['consent_expired', `consent-expired:${lapsed}:2026-10-17`],
    ]);
    await notifyExpiringConsents(t.db, { now });
    expect(await notificationsOf(b)).toHaveLength(1);
  });

  it('leaves Trading 212 connections and connections without a consent date alone', async () => {
    const c = await t.household();
    await addTrading212Connection(c, makeDeps(undefined, fakeTrading212()), {
      apiKey: 'k',
      apiSecret: 's',
      displayName: 'Broker',
    });
    await notifyExpiringConsents(t.db, { now });
    expect(await notificationsOf(c)).toEqual([]);
  });
});

describe('notification read state', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let other: ServiceCtx;
  const base = new Date('2026-10-18T09:00:00.000Z');

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const as = (
    ctx: ServiceCtx,
    userId: string,
    role: ServiceCtx['role'] = 'member',
  ): ServiceCtx => ({
    ...ctx,
    userId,
    role,
  });

  let tick = 0;
  async function seed(ctx: ServiceCtx, n: number, userId: string | null = null) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [row] = await t.owner
        .insert(notification)
        .values({
          householdId: ctx.householdId,
          userId,
          kind: 'sync_failing',
          payload: { n: i },
          createdAt: new Date(base.getTime() + (tick += 1) * 1000),
        })
        .returning({ id: notification.id });
      ids.push(row!.id);
    }
    return ids;
  }

  it('requires push_test to be user-scoped (a null user would broadcast it)', async () => {
    const ctx = await t.household();
    const create = (userId: string | null) =>
      withHousehold(t.db, ctx.householdId, (tx) =>
        createNotificationInTx(tx, {
          householdId: ctx.householdId,
          kind: 'push_test',
          userId,
          payload: {},
          dedupeKey: `test-${Math.random()}`,
        } as Parameters<typeof createNotificationInTx>[1]),
      );
    await expect(create(null)).rejects.toThrow(/push_test.*user/);
    await expect(create('user-1')).resolves.toBe(true);
  });

  it('keeps push_test notifications (push only) out of the in-app list, the count and mark-all', async () => {
    const ctx = await t.household();
    await t.owner.insert(notification).values({
      householdId: ctx.householdId,
      userId: 'user-1',
      kind: 'push_test',
      payload: {},
      createdAt: new Date(base.getTime() + (tick += 1) * 1000),
    });
    const [visible] = await seed(ctx, 1);

    const page = await listNotifications(ctx, { limit: 10 });
    expect(page.items.map((n) => n.id)).toEqual([visible]);
    expect(await unreadNotificationCount(ctx)).toBe(1);
    expect(await markAllNotificationsRead(ctx)).toEqual({ marked: 1 });
  });

  it('lists household-wide rows and own rows only, newest first, with a per-user read flag', async () => {
    a = await t.household();
    other = await t.household();
    const [shared1, shared2] = await seed(a, 2);
    const [mine] = await seed(a, 1, 'user-1');
    await seed(a, 1, 'user-2');
    await seed(other, 1);

    const u1 = as(a, 'user-1');
    const u2 = as(a, 'user-2');
    const page = await listNotifications(u1, { limit: 10 });
    expect(page.items.map((n) => n.id)).toEqual([mine, shared2, shared1]);
    expect(page.items.every((n) => !n.read)).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ kind: 'sync_failing', payload: { n: 0 } });
    expect(page.items[0]!.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'payload',
      'read',
    ]);
    expect(await unreadNotificationCount(u1)).toBe(3);
    expect(await unreadNotificationCount(u2)).toBe(3);

    await markNotificationRead(u1, shared2!);
    const after1 = await listNotifications(u1, { limit: 10 });
    expect(after1.items.map((n) => [n.id, n.read])).toEqual([
      [mine, false],
      [shared2, true],
      [shared1, false],
    ]);
    // Reading is per user: user-2 still sees it unread.
    expect((await listNotifications(u2, { limit: 10 })).items.some((n) => n.read)).toBe(false);
    expect(await unreadNotificationCount(u1)).toBe(2);
    expect(await unreadNotificationCount(u2)).toBe(3);
    // Idempotent.
    await markNotificationRead(u1, shared2!);
    expect(await unreadNotificationCount(u1)).toBe(2);
  });

  it('pages with an opaque cursor without skipping or repeating rows', async () => {
    const ctx = as(await t.household(), 'user-1');
    const ids = await seed(ctx, 5);
    const first = await listNotifications(ctx, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listNotifications(ctx, { limit: 2, cursor: first.nextCursor! });
    const third = await listNotifications(ctx, { limit: 2, cursor: second.nextCursor! });
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((n) => n.id)).toEqual(
      [...ids].reverse(),
    );
    await expect(listNotifications(ctx, { limit: 2, cursor: 'garbage' })).rejects.toThrow(
      /cursor/i,
    );
  });

  it('refuses to mark what the user cannot see, and malformed or unknown ids', async () => {
    const ctx = as(await t.household(), 'user-1');
    const [theirs] = await seed(ctx, 1, 'user-2');
    const [foreign] = await seed(other, 1);
    await expect(markNotificationRead(ctx, theirs!)).rejects.toBeInstanceOf(NotFoundError);
    await expect(markNotificationRead(ctx, foreign!)).rejects.toBeInstanceOf(NotFoundError);
    await expect(markNotificationRead(ctx, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(await unreadNotificationCount(ctx)).toBe(0);
  });

  it('marks everything visible as read for this user only, and viewers may do it', async () => {
    const ctx = await t.household();
    await seed(ctx, 3);
    await seed(ctx, 1, 'viewer-1');
    await seed(ctx, 1, 'user-2');
    const viewer = as(ctx, 'viewer-1', 'viewer');
    const member = as(ctx, 'user-1');

    expect(await unreadNotificationCount(viewer)).toBe(4);
    expect(await markAllNotificationsRead(viewer)).toEqual({ marked: 4 });
    expect(await unreadNotificationCount(viewer)).toBe(0);
    expect(await markAllNotificationsRead(viewer)).toEqual({ marked: 0 });
    expect(await unreadNotificationCount(member)).toBe(3);

    const [fresh] = await seed(ctx, 1);
    expect(await unreadNotificationCount(viewer)).toBe(1);
    await expect(markNotificationRead(withRole(viewer, 'viewer'), fresh!)).resolves.toBeUndefined();
    expect(await unreadNotificationCount(viewer)).toBe(0);
  });
});
