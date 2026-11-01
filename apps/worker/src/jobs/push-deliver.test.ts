import { randomBytes, randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@arfolio/db';
import { loadEncryptionKey } from '@arfolio/core/server';
import type { PushPayload, PushSender } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import {
  enqueuePushDeliver,
  PUSH_DELIVER_CRON,
  queuePushDelivery,
  registerPushDeliver,
  runPushDeliverJob,
} from './push-deliver.js';

const logged = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('../log.js', () => ({
  log: {
    info: () => {},
    warn: (msg: string) => {
      logged.warn.push(msg);
    },
    error: () => {},
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
}));

const ENCRYPTION_KEY = loadEncryptionKey('ab'.repeat(32));

describe('push-deliver job', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  const ends: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    const own = createDb(testDb.ownerUrl, { max: 2 });
    db = app.db;
    owner = own.db;
    ends.push(
      () => app.pool.end(),
      () => own.pool.end(),
    );
  });
  afterAll(async () => {
    for (const end of ends) await end();
    await testDb?.drop();
  });

  const deps = (sender: PushSender, extra: Record<string, unknown> = {}) => ({
    db,
    encryptionKey: ENCRYPTION_KEY,
    allowedHosts: [] as string[],
    sender,
    ...extra,
  });

  async function setup() {
    const householdId = `hh_${randomUUID()}`;
    const userId = `u_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id: householdId, name: 'T', slug: householdId, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId, locale: 'pt-PT' });
    await owner.insert(schema.user).values({ id: userId, name: 'U', email: `${userId}@x.test` });
    await owner.insert(schema.member).values({
      id: randomUUID(),
      organizationId: householdId,
      userId,
      role: 'owner',
      createdAt: new Date(),
    });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await owner.insert(schema.pushSubscription).values({
      householdId,
      userId,
      endpoint,
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    });
    const [n] = await owner
      .insert(schema.notification)
      .values({
        householdId,
        kind: 'sync_failing',
        payload: {},
        dedupeKey: randomUUID(),
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: schema.notification.id });
    return { householdId, endpoint, notificationId: n!.id };
  }

  it('delivers pending notifications through the injected sender with the instance VAPID identity', async () => {
    const { endpoint, notificationId } = await setup();
    const sent: Array<{ endpoint: string; payload: PushPayload; subject: string }> = [];
    const sender: PushSender = async (target, payload, vapid) => {
      sent.push({ endpoint: target.endpoint, payload, subject: vapid.subject });
      return { statusCode: 201 };
    };

    await runPushDeliverJob(deps(sender, { appUrl: 'https://pfm.example.com' }));

    const mine = sent.filter((s) => s.endpoint === endpoint);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload).toMatchObject({
      tag: notificationId,
      title: 'Falha na sincronização',
    });
    expect(mine[0]!.subject).toBe('https://pfm.example.com');
    const [row] = await owner
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.id, notificationId));
    expect(row!.pushedAt).not.toBeNull();
  });

  it('warns once per run, without any endpoint, when the push service refuses the VAPID identity', async () => {
    const a = await setup();
    const b = await setup();
    logged.warn.length = 0;
    const sender: PushSender = async () => ({ statusCode: 403 });

    await runPushDeliverJob(deps(sender));

    const rejected = logged.warn.filter((m) => /push rejected/.test(m));
    expect(rejected).toEqual(['push rejected (401/403): check the VAPID keys and subject']);
    for (const m of logged.warn) {
      expect(m).not.toContain(a.endpoint);
      expect(m).not.toContain(b.endpoint);
    }
  });

  it('warns once per run, without any endpoint, when stored endpoints are outside the allowlist', async () => {
    const a = await setup();
    const b = await setup();
    const badEndpoints = [
      `https://internal-a.example.test/${randomUUID()}`,
      `https://internal-b.example.test/${randomUUID()}`,
    ];
    for (const [i, h] of [a, b].entries()) {
      await owner
        .update(schema.pushSubscription)
        .set({ endpoint: badEndpoints[i]! })
        .where(eq(schema.pushSubscription.householdId, h.householdId));
    }
    logged.warn.length = 0;
    const sender: PushSender = async () => ({ statusCode: 201 });

    await runPushDeliverJob(deps(sender));

    const warned = logged.warn.filter((m) => /allowlist/.test(m));
    expect(warned).toEqual([
      'endpoint not in the push allowlist (check PUSH_ALLOWED_HOSTS on the worker)',
    ]);
    for (const m of logged.warn) for (const e of badEndpoints) expect(m).not.toContain(e);
  });

  it('queues one singleton job, never retried', async () => {
    const sent: unknown[][] = [];
    await enqueuePushDeliver(async (...args) => void sent.push(args));
    expect(sent).toEqual([
      [QUEUES.pushDeliver, {}, { singletonKey: 'push-deliver', retryLimit: 0 }],
    ]);
  });

  it('queuePushDelivery swallows a queueing failure (it must never fail the job that notified)', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('boss down'));
    await expect(queuePushDelivery(enqueue)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('registers the queue, schedules it every minute and returns the enqueue function', async () => {
    const calls: string[] = [];
    let cron = '';
    const sent: Array<{ name: string; options: unknown }> = [];
    const boss = {
      send: async (name: string, _data: unknown, options: unknown) =>
        void sent.push({ name, options }),
      createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
      work: async (n: string) => void calls.push(`work:${n}`),
      schedule: async (n: string, c: string) => {
        calls.push(`schedule:${n}`);
        cron = c;
      },
    } as unknown as PgBoss;

    const enqueue = await registerPushDeliver(
      boss,
      deps(async () => ({ statusCode: 201 })),
      'UTC',
    );

    expect(calls).toEqual([
      `createQueue:${QUEUES.pushDeliver}`,
      `work:${QUEUES.pushDeliver}`,
      `schedule:${QUEUES.pushDeliver}`,
    ]);
    expect(cron).toBe(PUSH_DELIVER_CRON);
    expect(PUSH_DELIVER_CRON).toBe('* * * * *');
    await enqueue();
    expect(sent).toEqual([
      { name: QUEUES.pushDeliver, options: { singletonKey: 'push-deliver', retryLimit: 0 } },
    ]);
  });
});
