import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import { decryptSecret, loadEncryptionKey } from '@arfolio/core/server';
import {
  findMyPushDevice,
  isPushEndpoint,
  listMyPushDevices,
  sendTestPush,
  NotFoundError,
  subscribePush,
  unsubscribePush,
  ValidationError,
  vapidKeys,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { pushSubscription, instanceSecret } = schema;
const b64u = (n: number) => randomBytes(n).toString('base64url');
const keys = () => ({
  p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
  auth: b64u(16),
});
const input = (endpoint: string, userAgent = 'UA') => ({ endpoint, keys: keys(), userAgent });
const USERS = ['user-1', 'alice', 'bob', 'viewer-1', 'carol', 'dave', 'erin'];
const ENC_KEY = loadEncryptionKey('ab'.repeat(32));

describe('push subscriptions', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  const as = (ctx: ServiceCtx, userId: string): ServiceCtx => ({ ...ctx, userId });

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    // push_subscription.user_id references user(id)
    await t.owner
      .insert(schema.user)
      .values(USERS.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  });
  afterAll(() => t.close());

  const rowsOf = (endpoint: string) =>
    t.owner.select().from(pushSubscription).where(eq(pushSubscription.endpoint, endpoint));

  it('subscribes and lists only id, userAgent, createdAt, lastSuccessAt, failureCount', async () => {
    await subscribePush(a, input('https://fcm.googleapis.com/fcm/send/one', 'Firefox'));
    const devices = await listMyPushDevices(a);
    expect(devices).toHaveLength(1);
    expect(Object.keys(devices[0]!).sort()).toEqual(
      ['createdAt', 'failureCount', 'id', 'lastSuccessAt', 'userAgent'].sort(),
    );
    expect(devices[0]).toMatchObject({
      userAgent: 'Firefox',
      failureCount: 0,
      lastSuccessAt: null,
    });
  });

  it('is an upsert by endpoint: same user keeps one row and refreshes keys, clearing backoff', async () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/upsert';
    await subscribePush(a, input(ep));
    await t.owner
      .update(pushSubscription)
      .set({ failureCount: 3, nextAttemptAt: new Date() })
      .where(eq(pushSubscription.endpoint, ep));
    const fresh = input(ep, 'New UA');
    await subscribePush(a, fresh);
    const rows = await rowsOf(ep);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      p256dh: fresh.keys.p256dh,
      auth: fresh.keys.auth,
      userAgent: 'New UA',
      failureCount: 0,
      nextAttemptAt: null,
    });
  });

  it('moves an endpoint to another user of the same household', async () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/same-household';
    await subscribePush(as(a, 'alice'), input(ep));
    await subscribePush(as(a, 'bob'), input(ep));
    const rows = await rowsOf(ep);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'bob', householdId: a.householdId });
  });

  it('moves an endpoint across households (claim_push_endpoint) so the latest subscriber owns the device', async () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/cross-household';
    await subscribePush(a, input(ep));
    await subscribePush(b, input(ep));
    const rows = await rowsOf(ep);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ householdId: b.householdId, userId: b.userId });
    expect(await listMyPushDevices(b)).toHaveLength(1);
    const aEndpoints = (
      await t.owner
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.householdId, a.householdId))
    ).map((r) => r.endpoint);
    expect(aEndpoints).not.toContain(ep);
  });

  it('lets viewers subscribe their own devices', async () => {
    await subscribePush(
      withRole(as(a, 'viewer-1'), 'viewer'),
      input('https://fcm.googleapis.com/fcm/send/viewer'),
    );
    expect((await rowsOf('https://fcm.googleapis.com/fcm/send/viewer'))[0]).toMatchObject({
      userId: 'viewer-1',
    });
  });

  it('lists and unsubscribes only the caller own devices', async () => {
    const mine = as(a, 'carol');
    const theirs = as(a, 'dave');
    await subscribePush(mine, input('https://fcm.googleapis.com/fcm/send/carol'));
    await subscribePush(theirs, input('https://fcm.googleapis.com/fcm/send/dave'));
    const [dev] = await listMyPushDevices(mine);
    expect(dev).toBeDefined();
    expect(await listMyPushDevices(mine)).toHaveLength(1);
    const [daveRow] = await rowsOf('https://fcm.googleapis.com/fcm/send/dave');
    await expect(unsubscribePush(mine, { id: daveRow!.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      unsubscribePush(mine, { endpoint: 'https://fcm.googleapis.com/fcm/send/dave' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await rowsOf('https://fcm.googleapis.com/fcm/send/dave')).toHaveLength(1);
    await unsubscribePush(mine, { id: dev!.id });
    expect(await rowsOf('https://fcm.googleapis.com/fcm/send/carol')).toEqual([]);
  });

  it('unsubscribes by endpoint (the browser own subscription), idempotently not found afterwards', async () => {
    const ctx = as(a, 'erin');
    await subscribePush(ctx, input('https://fcm.googleapis.com/fcm/send/erin'));
    await unsubscribePush(ctx, { endpoint: 'https://fcm.googleapis.com/fcm/send/erin' });
    expect(await rowsOf('https://fcm.googleapis.com/fcm/send/erin')).toEqual([]);
    await expect(
      unsubscribePush(ctx, { endpoint: 'https://fcm.googleapis.com/fcm/send/erin' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a malformed device id is not found', async () => {
    await expect(unsubscribePush(a, { id: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('survives two households subscribing the same endpoint at the same moment (one retry)', async () => {
    const endpoints = Array.from(
      { length: 24 },
      (_, i) => `https://fcm.googleapis.com/fcm/send/race-${i}`,
    );
    const results = await Promise.allSettled(
      endpoints.flatMap((ep) => [subscribePush(a, input(ep)), subscribePush(b, input(ep))]),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const ep of endpoints) expect(await rowsOf(ep)).toHaveLength(1);
  });

  it('stores the normalised URL, and unsubscribes by either spelling', async () => {
    const raw = 'https://FCM.GoogleAPIs.com:443/fcm/send/Norm Case?x=a b';
    const href = new URL(raw).href;
    expect(href).not.toBe(raw);
    await subscribePush(as(a, 'erin'), input(raw));
    expect((await rowsOf(href))[0]).toMatchObject({ userId: 'erin', endpoint: href });
    await subscribePush(as(a, 'erin'), input(href));
    expect(await rowsOf(href)).toHaveLength(1);
    await unsubscribePush(as(a, 'erin'), { endpoint: raw });
    expect(await rowsOf(href)).toEqual([]);
  });

  it('accepts hosts from the allowedHosts option', async () => {
    const ep = 'https://up.push.example.org/message/abc';
    await expect(subscribePush(a, input(ep))).rejects.toBeInstanceOf(ValidationError);
    await subscribePush(a, input(ep), { allowedHosts: ['push.example.org'] });
    expect(await rowsOf(ep)).toHaveLength(1);
  });

  describe('validation', () => {
    it.each([
      ['http endpoint', { ...input('http://push.example/x') }],
      ['not a URL', { ...input('nonsense') }],
      [
        'endpoint too long',
        { ...input('https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(2048)) },
      ],
      ['IP literal endpoint', { ...input('https://127.0.0.1/x') }],
      ['single-label host', { ...input('https://localhost/x') }],
      ['userinfo in endpoint', { ...input('https://user:pw@push.example/x') }],
      [
        'p256dh wrong length',
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/v',
          keys: { p256dh: b64u(64), auth: b64u(16) },
          userAgent: 'x',
        },
      ],
      [
        'p256dh not base64url',
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/v',
          keys: { p256dh: '+'.repeat(87), auth: b64u(16) },
          userAgent: 'x',
        },
      ],
      [
        'auth wrong length',
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/v',
          keys: { ...keys(), auth: b64u(8) },
          userAgent: 'x',
        },
      ],
    ])('rejects %s', async (_name, bad) => {
      await expect(subscribePush(a, bad)).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts an endpoint of exactly 2048 chars and truncates nothing', async () => {
      const ep =
        'https://fcm.googleapis.com/fcm/send/' +
        'a'.repeat(2048 - 'https://fcm.googleapis.com/fcm/send/'.length);
      expect(ep).toHaveLength(2048);
      await subscribePush(a, input(ep));
      expect(await rowsOf(ep)).toHaveLength(1);
    });

    it('caps the user agent instead of failing', async () => {
      await subscribePush(
        a,
        input('https://fcm.googleapis.com/fcm/send/long-ua', 'x'.repeat(1000)),
      );
      expect(
        (await rowsOf('https://fcm.googleapis.com/fcm/send/long-ua'))[0]!.userAgent,
      ).toHaveLength(256);
    });
  });
});

describe('vapidKeys', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const secretRows = () => t.owner.select().from(instanceSecret);

  it('generates a standard VAPID pair once, stores the private key encrypted, and returns it again', async () => {
    const deps = { db: t.db, encryptionKey: ENC_KEY };
    const first = await vapidKeys(deps);
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(first.publicKey, 'base64url')[0]).toBe(4);
    expect(Buffer.from(first.privateKey, 'base64url')).toHaveLength(32);
    expect(await vapidKeys(deps)).toEqual(first);
    const rows = await secretRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).not.toContain(first.privateKey);
    const stored = JSON.parse(rows[0]!.value) as { publicKey: string; privateKey: string };
    expect(stored.publicKey).toBe(first.publicKey);
    expect(decryptSecret(stored.privateKey, ENC_KEY, 'instance:vapid')).toBe(first.privateKey);
  });

  it('is idempotent under concurrency: every caller sees the same pair', async () => {
    const t2 = await startServicesDb();
    try {
      const deps = { db: t2.db, encryptionKey: ENC_KEY };
      const results = await Promise.all(Array.from({ length: 8 }, () => vapidKeys(deps)));
      expect(new Set(results.map((r) => r.publicKey)).size).toBe(1);
      expect(new Set(results.map((r) => r.privateKey)).size).toBe(1);
      expect(await t2.owner.select().from(instanceSecret)).toHaveLength(1);
    } finally {
      await t2.close();
    }
  });

  it('fails when the stored key cannot be decrypted (wrong ENCRYPTION_KEY)', async () => {
    await expect(
      vapidKeys({ db: t.db, encryptionKey: loadEncryptionKey('cd'.repeat(32)) }),
    ).rejects.toThrow(/decrypt/i);
  });

  it('env wins when both keys are set, without touching the database', async () => {
    const t2 = await startServicesDb();
    try {
      const env = { publicKey: b64u(65), privateKey: b64u(32), subject: 'mailto:ops@example.test' };
      expect(await vapidKeys({ db: t2.db, encryptionKey: ENC_KEY, ...env })).toEqual(env);
      expect(await t2.owner.select().from(instanceSecret)).toEqual([]);
    } finally {
      await t2.close();
    }
  });

  it('refuses a half-configured env pair with an EnvError', async () => {
    await expect(
      vapidKeys({ db: t.db, encryptionKey: ENC_KEY, publicKey: b64u(65) }),
    ).rejects.toMatchObject({ name: 'EnvError', keys: ['VAPID_PRIVATE_KEY'] });
    await expect(
      vapidKeys({ db: t.db, encryptionKey: ENC_KEY, privateKey: b64u(32) }),
    ).rejects.toMatchObject({ name: 'EnvError', keys: ['VAPID_PUBLIC_KEY'] });
  });

  it('rejects an explicit subject that is neither mailto: nor https:', async () => {
    for (const subject of ['http://pfm.example.test', 'ops@example.test', 'javascript:1']) {
      await expect(vapidKeys({ db: t.db, encryptionKey: ENC_KEY, subject })).rejects.toMatchObject({
        name: 'EnvError',
        keys: ['VAPID_SUBJECT'],
      });
    }
  });

  it('subject: explicit, else https APP_URL, else mailto:no-reply@localhost', async () => {
    const base = { db: t.db, encryptionKey: ENC_KEY };
    expect((await vapidKeys({ ...base, subject: 'mailto:a@b.test' })).subject).toBe(
      'mailto:a@b.test',
    );
    expect((await vapidKeys({ ...base, appUrl: 'https://pfm.example.test' })).subject).toBe(
      'https://pfm.example.test',
    );
    expect((await vapidKeys({ ...base, appUrl: 'http://localhost:3000' })).subject).toBe(
      'mailto:no-reply@localhost',
    );
    expect((await vapidKeys(base)).subject).toBe('mailto:no-reply@localhost');
  });
});

describe('isPushEndpoint (push-service host allowlist)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
    'https://push.apple.com/abc',
  ])('accepts %s', (url) => {
    expect(isPushEndpoint(url)).toBe(true);
  });

  it.each([
    // the review's SSRF examples
    'https://kubernetes.default.svc/',
    'https://vault.internal/',
    'https://foo.local/',
    'https://fcm.googleapis.com:6379/',
    'https://localhost./',
    // suffix must match on a label boundary
    'https://evilfcm.googleapis.com.attacker/',
    'https://notfcm.googleapis.com/',
    'https://fcm.googleapis.com.evil.com/',
    'https://xpush.apple.com/',
    // port, scheme, credentials, trailing dot, IPs
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com@evil.example.com/',
    'https://fcm.googleapis.com./fcm/send/abc',
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://2130706433/',
    'https://[::1]/',
    'https://evil.com\\@fcm.googleapis.com/',
    'fcm.googleapis.com/fcm/send/abc',
    '',
  ])('rejects %s', (url) => {
    expect(isPushEndpoint(url)).toBe(false);
  });

  it('adds extra suffixes on a label boundary and does not let them loosen the other rules', () => {
    const extra = ['push.example.org'];
    expect(isPushEndpoint('https://push.example.org/x', extra)).toBe(true);
    expect(isPushEndpoint('https://up.push.example.org/x', extra)).toBe(true);
    expect(isPushEndpoint('https://notpush.example.org/x', extra)).toBe(false);
    expect(isPushEndpoint('https://push.example.org:8443/x', extra)).toBe(false);
    expect(isPushEndpoint('http://push.example.org/x', extra)).toBe(false);
    expect(isPushEndpoint('https://push.example.org./x', extra)).toBe(false);
  });
});

describe('push settings helpers', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  const as = (ctx: ServiceCtx, userId: string): ServiceCtx => ({ ...ctx, userId });

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    await t.owner
      .insert(schema.user)
      .values(USERS.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  });
  afterAll(() => t.close());

  it("finds only the caller's own device by endpoint, whatever the spelling", async () => {
    const ep = 'https://fcm.googleapis.com/fcm/send/find-me';
    const { id } = await subscribePush(as(a, 'alice'), input(ep));
    expect(await findMyPushDevice(as(a, 'alice'), ep)).toEqual({ id });
    expect(
      await findMyPushDevice(as(a, 'alice'), 'https://FCM.googleapis.com:443/fcm/send/find-me'),
    ).toEqual({
      id,
    });
    expect(await findMyPushDevice(as(a, 'bob'), ep)).toBeNull();
    expect(
      await findMyPushDevice(as(a, 'alice'), 'https://fcm.googleapis.com/fcm/send/other'),
    ).toBeNull();
  });

  it('sends a test as a user-scoped push_test notification, one per user per minute', async () => {
    const now = new Date('2026-10-23T10:00:30Z');
    expect(await sendTestPush(as(a, 'carol'), { now })).toEqual({ created: true });
    expect(await sendTestPush(as(a, 'carol'), { now: new Date('2026-10-23T10:00:59Z') })).toEqual({
      created: false,
    });
    expect(await sendTestPush(as(a, 'dave'), { now })).toEqual({ created: true });
    expect(await sendTestPush(as(a, 'carol'), { now: new Date('2026-10-23T10:01:00Z') })).toEqual({
      created: true,
    });
    const rows = await t.owner
      .select()
      .from(schema.notification)
      .where(
        and(
          eq(schema.notification.householdId, a.householdId),
          eq(schema.notification.kind, 'push_test'),
        ),
      );
    expect(rows.map((r) => r.userId).sort()).toEqual(['carol', 'carol', 'dave']);
    expect(rows.every((r) => Object.keys(r.payload as object).length === 0)).toBe(true);
  });

  it('lets a viewer send a test to their own devices', async () => {
    const viewer = withRole(as(a, 'viewer-1'), 'viewer');
    expect(await sendTestPush(viewer)).toEqual({ created: true });
  });
});
