import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import { pruneSyncData } from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { connection, consentState, notification, oauthClient, oauthConsent, syncRun } = schema;
const DAY = 86_400_000;

describe('pruneSyncData', () => {
  let t: ServicesTestDb;
  const now = new Date('2026-10-18T12:00:00.000Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function householdWithConnection() {
    const ctx = await t.household();
    const connectionId = randomUUID();
    await t.owner.insert(connection).values({
      id: connectionId,
      householdId: ctx.householdId,
      provider: 'trading212',
      displayName: 'Broker',
      status: 'active',
      createdBy: ctx.userId,
    });
    return { ctx, connectionId };
  }

  const state = (householdId: string, createdAt: Date) => ({
    householdId,
    stateHash: randomUUID(),
    userId: 'user-1',
    aspspName: 'Test Bank',
    aspspCountry: 'PT',
    expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
    createdAt,
  });
  const run = (householdId: string, connectionId: string, startedAt: Date) => ({
    householdId,
    connectionId,
    trigger: 'scheduled' as const,
    status: 'success' as const,
    startedAt,
  });

  it('deletes consent states older than a day and sync runs older than 180 days, in every household', async () => {
    const x = await householdWithConnection();
    const y = await householdWithConnection();
    const stale = [x, y].map((h) => state(h.ctx.householdId, ago(2)));
    const fresh = [x, y].map((h) => state(h.ctx.householdId, new Date(now.getTime() - 60_000)));
    await t.owner.insert(consentState).values([...stale, ...fresh]);
    const oldRuns = [x, y].map((h) => run(h.ctx.householdId, h.connectionId, ago(181)));
    const keptRuns = [
      ...[x, y].map((h) => run(h.ctx.householdId, h.connectionId, ago(179))),
      run(x.ctx.householdId, x.connectionId, now),
    ];
    await t.owner.insert(syncRun).values([...oldRuns, ...keptRuns]);

    const result = await pruneSyncData(t.db, { now });

    expect(result.consentStates).toBeGreaterThanOrEqual(2);
    expect(result.syncRuns).toBeGreaterThanOrEqual(2);
    const states = await t.owner
      .select({ hash: consentState.stateHash })
      .from(consentState)
      .where(
        inArray(
          consentState.stateHash,
          [...stale, ...fresh].map((s) => s.stateHash),
        ),
      );
    expect(states.map((s) => s.hash).sort()).toEqual(fresh.map((s) => s.stateHash).sort());
    for (const h of [x, y]) {
      const remaining = await t.owner
        .select({ startedAt: syncRun.startedAt })
        .from(syncRun)
        .where(eq(syncRun.connectionId, h.connectionId));
      expect(remaining.every((r) => r.startedAt >= ago(180))).toBe(true);
    }
    expect(
      await t.owner.select().from(syncRun).where(eq(syncRun.connectionId, x.connectionId)),
    ).toHaveLength(2);
    expect(
      await t.owner.select().from(syncRun).where(eq(syncRun.connectionId, y.connectionId)),
    ).toHaveLength(1);
  });

  it('deletes push_test notifications older than two days and keeps everything else', async () => {
    const ctx = await t.household();
    const row = (kind: 'push_test' | 'sync_failing', age: number, key: string) => ({
      householdId: ctx.householdId,
      userId: kind === 'push_test' ? ctx.userId : null,
      kind,
      payload: {},
      dedupeKey: `prune-${key}`,
      createdAt: ago(age),
    });
    await t.owner
      .insert(notification)
      .values([
        row('push_test', 3, 'old-test'),
        row('push_test', 1, 'new-test'),
        row('sync_failing', 400, 'old-other'),
      ]);
    const result = await pruneSyncData(t.db, { now });
    expect(result.pushTests).toBeGreaterThanOrEqual(1);
    const left = await t.owner
      .select({ key: notification.dedupeKey })
      .from(notification)
      .where(eq(notification.householdId, ctx.householdId));
    expect(left.map((r) => r.key).sort()).toEqual(['prune-new-test', 'prune-old-other']);
  });

  it('is a no-op on recent data and reports zero', async () => {
    const { ctx, connectionId } = await householdWithConnection();
    await t.owner.insert(consentState).values(state(ctx.householdId, now));
    await t.owner.insert(syncRun).values(run(ctx.householdId, connectionId, ago(10)));
    // Earlier tests may have left old rows; a first pass clears them.
    await pruneSyncData(t.db, { now });
    expect(await pruneSyncData(t.db, { now })).toEqual({
      consentStates: 0,
      syncRuns: 0,
      pushTests: 0,
      oauthClients: 0,
    });
    expect(
      await t.owner.select().from(syncRun).where(eq(syncRun.connectionId, connectionId)),
    ).toHaveLength(1);
  });

  it('deletes OAuth clients that were never consented to after 7 days, and nothing else', async () => {
    const client = (clientId: string, createdAt: Date) => ({
      id: `row-${clientId}`,
      clientId,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      createdAt,
      updatedAt: createdAt,
    });
    const userId = `user-${randomUUID()}`;
    await t.owner
      .insert(schema.user)
      .values({ id: userId, name: 'Grantee', email: `${userId}@example.com` });
    await t.owner
      .insert(oauthClient)
      .values([
        client('orphan-old', ago(8)),
        client('orphan-recent', ago(6)),
        client('consented-old', ago(30)),
      ]);
    await t.owner.insert(oauthConsent).values({
      id: randomUUID(),
      clientId: 'consented-old',
      userId,
      scopes: ['pfm:read'],
      createdAt: ago(29),
      updatedAt: ago(29),
    });

    const result = await pruneSyncData(t.db, { now });

    expect(result.oauthClients).toBe(1);
    const left = await t.owner
      .select({ clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(inArray(oauthClient.clientId, ['orphan-old', 'orphan-recent', 'consented-old']));
    expect(left.map((c) => c.clientId).sort()).toEqual(['consented-old', 'orphan-recent']);
  });
});
