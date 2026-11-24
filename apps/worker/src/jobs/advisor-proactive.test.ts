import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@arfolio/db';
import {
  createBudget,
  createCategory,
  createCategoryGroup,
  linkCategories,
  saveMemberSettings,
  setLineAmounts,
  upsertBudgetLine,
  type ServiceCtx,
} from '@arfolio/services';
import type { AdvisorModelClient } from '@arfolio/mcp/advisor';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';
import {
  ADVISOR_PROACTIVE_CRON,
  registerAdvisorProactive,
  runAdvisorProactive,
  type AdvisorProactiveDeps,
} from './advisor-proactive.js';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorMessage: () => 'error',
}));

const NOW = new Date('2026-11-24T10:00:00Z');
const LIMITS = { learningMonths: 3, weeklyCap: 2, dailyMessages: 50, maxToolCalls: 8 };

const answer = (text: string): Anthropic.Message =>
  ({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

/** A model that answers every request; `failOn` makes the nth call (1-based) throw. */
function fakeClient(failOn?: number) {
  const calls: Anthropic.MessageCreateParamsStreaming[] = [];
  const client: AdvisorModelClient = {
    async stream(params, onText) {
      calls.push(structuredClone({ ...params, messages: [...params.messages] }));
      if (calls.length === failOn) throw new Error('secret amount 123456');
      onText('A short note.');
      return answer('A short note.');
    },
  };
  return { client, calls };
}

describe('advisor-proactive job', () => {
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
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
  });

  type Fixture = {
    householdId: string;
    users: Record<string, ServiceCtx>;
  };

  /** A household with AI on and the given members; each has a chat message unless `fresh`. */
  async function household(
    over: {
      aiEnabled?: boolean;
      roles?: Array<'owner' | 'member' | 'viewer'>;
      fresh?: boolean;
      /** With `fresh`: the members opened the advisor (no message yet), so check-ins may start. */
      opened?: boolean;
      /** Detected recurring items created `now`. */
      detected?: number;
    } = {},
  ): Promise<Fixture> {
    const householdId = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id: householdId, name: 'Test', slug: householdId, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({
      householdId,
      timezone: 'UTC',
      aiEnabled: over.aiEnabled ?? true,
      locale: 'pt-PT',
      currency: 'EUR',
    });
    const users: Record<string, ServiceCtx> = {};
    for (const role of over.roles ?? ['owner']) {
      const userId = `u_${randomUUID()}`;
      await owner.insert(schema.user).values({
        id: userId,
        name: 'Someone',
        email: `${userId}@example.com`,
        createdAt: new Date(),
      });
      await owner.insert(schema.member).values({
        id: randomUUID(),
        organizationId: householdId,
        userId,
        role,
        createdAt: new Date(),
      });
      users[role] = { db, householdId, userId, role };
      if (over.fresh && over.opened) {
        await owner.insert(schema.advisorMemberSettings).values({
          householdId,
          userId,
          proactiveEnabled: true,
          openedAt: new Date(),
        });
      }
      if (!over.fresh) {
        await owner.insert(schema.advisorMessage).values({
          householdId,
          userId,
          role: 'user',
          origin: 'chat',
          text: 'hello',
          status: 'complete',
        });
      }
    }
    for (let i = 0; i < (over.detected ?? 0); i += 1) {
      await owner.insert(schema.recurring).values({
        householdId,
        merchantKey: `shop-${i}`,
        name: `Shop ${i}`,
        amount: -1_000,
        currency: 'EUR',
        cadence: 'monthly',
        status: 'detected',
        source: 'detected',
        createdAt: NOW,
      });
    }
    return { householdId, users };
  }

  const depsFor = (client: AdvisorModelClient, over: Partial<AdvisorProactiveDeps> = {}) =>
    ({
      db,
      getConfig: async () => makeConfig({ anthropicApiKey: 'sk-ant-test-fake-key' }),
      getClient: () => client,
      limits: LIMITS,
      brandName: 'Acme Ledger',
      now: NOW,
      ...over,
    }) satisfies AdvisorProactiveDeps;

  const proactive = (householdId: string, userId: string) =>
    owner
      .select()
      .from(schema.advisorMessage)
      .where(
        and(
          eq(schema.advisorMessage.householdId, householdId),
          eq(schema.advisorMessage.userId, userId),
          eq(schema.advisorMessage.origin, 'proactive'),
        ),
      );

  it('does nothing when household AI is off', async () => {
    const f = await household({ aiEnabled: false, detected: 2 });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(calls).toHaveLength(0);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(0);
  });

  it('does nothing without an API key', async () => {
    const f = await household({ detected: 2 });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(
      depsFor(client, { getConfig: async () => makeConfig() }),
      f.householdId,
    );
    expect(calls).toHaveLength(0);
  });

  it('respects the weekly cap', async () => {
    const f = await household({ detected: 4 });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    const rows = await proactive(f.householdId, f.users.owner!.userId);
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(rows.every((r) => r.countsTowardCap)).toBe(true);
  });

  it("uses the member's own weekly cap when it is lower than the installation's", async () => {
    const f = await household({ detected: 4 });
    await saveMemberSettings(
      f.users.owner!,
      { proactiveEnabled: true, weeklyCap: 1 },
      { maxWeeklyCap: 2 },
    );
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(1);
  });

  it("never lets a member's weekly cap exceed the installation's", async () => {
    const f = await household({ detected: 4 });
    // Stored when the installation's cap was higher (or by a direct write): the worker clamps it.
    await owner.insert(schema.advisorMemberSettings).values({
      householdId: f.householdId,
      userId: f.users.owner!.userId,
      proactiveEnabled: true,
      weeklyCap: 9,
    });
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(2);
  });

  it('sends welcome and learned outside the cap', async () => {
    const f = await household({ fresh: true, opened: true, detected: 3 });
    // Two complete months of data and a one-month learning period: the profile is ready.
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId: f.householdId, name: 'Main', type: 'checking', currency: 'EUR' })
      .returning();
    await owner.insert(schema.transaction).values({
      householdId: f.householdId,
      accountId: account!.id,
      dedupeHash: randomUUID(),
      bookingDate: '2026-09-01',
      amount: -5_000,
      currency: 'EUR',
      status: 'booked',
      rawDescription: 'x',
      source: 'manual',
    });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(
      depsFor(client, { limits: { ...LIMITS, learningMonths: 1, weeklyCap: 1 } }),
      f.householdId,
    );
    const rows = await proactive(f.householdId, f.users.owner!.userId);
    expect(rows.map((r) => (r.eventKey ?? '').split(':')[0]).sort()).toEqual([
      'learned',
      'recurring',
      'welcome',
    ]);
    expect(rows.filter((r) => r.countsTowardCap)).toHaveLength(1);
    expect(calls).toHaveLength(3);
    // The household locale and the configured brand reach the model; the key is not a literal brand.
    expect(calls[0]!.system).toContain('pt-PT');
    expect(calls[0]!.system).toContain('Acme Ledger');
  });

  it('sends nothing to a member who has never opened the advisor', async () => {
    const f = await household({ roles: ['owner', 'member'], fresh: true, detected: 2 });
    await owner.insert(schema.advisorMemberSettings).values({
      householdId: f.householdId,
      userId: f.users.member!.userId,
      proactiveEnabled: true,
      openedAt: new Date(),
    });
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(0);
    expect((await proactive(f.householdId, f.users.member!.userId)).length).toBeGreaterThan(0);
  });

  /** One complete month of data (October) so a one-month learning period is over. */
  async function learnedHousehold() {
    const f = await household({ detected: 0 });
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId: f.householdId, name: 'Main', type: 'checking', currency: 'EUR' })
      .returning();
    const add = (bookingDate: string, amount: number, categoryId?: string) =>
      owner
        .insert(schema.transaction)
        .values({
          householdId: f.householdId,
          accountId: account!.id,
          dedupeHash: randomUUID(),
          bookingDate,
          amount,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'Example',
          source: 'manual',
          ...(categoryId ? { categoryId } : {}),
        })
        .returning({ id: schema.transaction.id });
    await add('2026-10-01', -20_000);
    await add('2026-10-02', 300_000);
    return { f, add };
  }
  const oneMonth = { ...LIMITS, learningMonths: 1 };
  const eventKeys = async (f: Fixture) =>
    (await proactive(f.householdId, f.users.owner!.userId)).map((r) => r.eventKey ?? '');

  it('writes about an unusual inflow, from the booked rows of the last days', async () => {
    const { f, add } = await learnedHousehold();
    const [big] = await add('2026-11-23', 200_000);
    await add('2026-11-23', 1_000); // far below half of a typical income
    await add('2026-11-10', 250_000); // older than three days
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client, { limits: oneMonth }), f.householdId);
    expect((await eventKeys(f)).filter((k) => k.startsWith('income:'))).toEqual([
      `income:${big!.id}`,
    ]);
  });

  it('writes about a budget line clearly over its plan this month', async () => {
    const { f, add } = await learnedHousehold();
    const ctx = f.users.owner!;
    const group = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
    const dining = await createCategory(ctx, { groupId: group.id, name: 'Dining' });
    const budget = await createBudget(ctx, { startMonth: '2026-01-01' });
    const line = await upsertBudgetLine(ctx, budget.id, { kind: 'expense', name: 'Dining out' });
    await setLineAmounts(
      ctx,
      line.id,
      Array.from({ length: 12 }, () => 10_000),
    );
    await linkCategories(ctx, line.id, [dining.id]);
    await add('2026-11-05', -11_000, dining.id); // exactly 110 %: not over
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client, { limits: oneMonth }), f.householdId);
    expect((await eventKeys(f)).filter((k) => k.startsWith('budget:'))).toEqual([]);

    await add('2026-11-06', -500, dining.id); // 115 %
    await runAdvisorProactive(depsFor(client, { limits: oneMonth }), f.householdId);
    expect((await eventKeys(f)).filter((k) => k.startsWith('budget:'))).toEqual([
      `budget:${line.id}:2026-11`,
    ]);
  });

  it('sends no capped message when the member cap is 0', async () => {
    const f = await household({ detected: 3 });
    await saveMemberSettings(
      f.users.owner!,
      { proactiveEnabled: true, weeklyCap: 0 },
      { maxWeeklyCap: 2 },
    );
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(calls).toHaveLength(0);
  });

  it('skips members with proactive off, viewers included in the rest', async () => {
    const f = await household({ roles: ['owner', 'member', 'viewer'], detected: 1 });
    await saveMemberSettings(
      f.users.member!,
      { proactiveEnabled: false, weeklyCap: null },
      { maxWeeklyCap: 2 },
    );
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(1);
    expect(await proactive(f.householdId, f.users.member!.userId)).toHaveLength(0);
    expect(await proactive(f.householdId, f.users.viewer!.userId)).toHaveLength(1);
  });

  it('creates a per-user advisor_message notification', async () => {
    const f = await household({ roles: ['owner', 'member'], detected: 1 });
    const { client } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    const rows = await owner
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.householdId, f.householdId));
    expect(rows).toHaveLength(2);
    for (const who of [f.users.owner!, f.users.member!]) {
      const msg = (await proactive(f.householdId, who.userId))[0]!;
      const mine = rows.filter((r) => r.userId === who.userId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        kind: 'advisor_message',
        payload: { messageId: msg.id },
        dedupeKey: `advisor:${who.userId}:${msg.eventKey}`,
      });
    }
  });

  it('does not repeat an event already sent', async () => {
    const f = await household({ detected: 1 });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(calls).toHaveLength(1);
    expect(await proactive(f.householdId, f.users.owner!.userId)).toHaveLength(1);
    const notes = await owner
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.householdId, f.householdId));
    expect(notes).toHaveLength(1);
  });

  it('ignores a detection older than three days', async () => {
    const f = await household();
    await owner.insert(schema.recurring).values({
      householdId: f.householdId,
      merchantKey: 'old',
      name: 'Old',
      amount: -1_000,
      currency: 'EUR',
      cadence: 'monthly',
      status: 'detected',
      source: 'detected',
      createdAt: new Date('2026-11-20T09:00:00Z'),
    });
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(calls).toHaveLength(0);
  });

  it("logs one member's failure by class and ids only, and carries on with the others", async () => {
    const f = await household({ roles: ['owner', 'member'], detected: 1 });
    const { client } = fakeClient(1);
    await runAdvisorProactive(depsFor(client), f.householdId);
    const sent = [
      ...(await proactive(f.householdId, f.users.owner!.userId)),
      ...(await proactive(f.householdId, f.users.member!.userId)),
    ];
    expect(sent).toHaveLength(1);
    const lines = vi.mocked(log.error).mock.calls.map(([m]) => m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(f.householdId);
    expect(lines[0]).not.toMatch(/secret|123456|Shop/);
  });

  it('stops the household run once when the shared figures cannot be loaded', async () => {
    const f = await household({ roles: ['owner', 'member'], detected: 1 });
    // An active budget makes the loader place today in its months, which refuses an unknown zone.
    await createBudget(f.users.owner!, { startMonth: '2026-01-01' });
    await owner
      .update(schema.householdSettings)
      .set({ timezone: 'Not/AZone' })
      .where(eq(schema.householdSettings.householdId, f.householdId));
    const { client, calls } = fakeClient();
    await runAdvisorProactive(depsFor(client), f.householdId);
    expect(calls).toHaveLength(0);
    const lines = vi.mocked(log.error).mock.calls.map(([m]) => m);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(f.householdId);
  });

  it('schedules the daily run at 09:00 and fans out one singleton job per AI household', async () => {
    expect(ADVISOR_PROACTIVE_CRON).toBe('0 9 * * *');
    const calls: string[] = [];
    let cron = '';
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const sent: Array<{ name: string; data: { householdId: string }; options: unknown }> = [];
    const boss = {
      send: async (name: string, data: { householdId: string }, options: unknown) =>
        void sent.push({ name, data, options }),
      createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => {
        calls.push(`work:${n}`);
        handlers.set(n, h);
      },
      schedule: async (n: string, c: string) => {
        calls.push(`schedule:${n}`);
        cron = c;
      },
    } as unknown as PgBoss;
    const afterNotify = vi.fn(async () => {});
    const { client } = fakeClient();
    await registerAdvisorProactive(boss, depsFor(client), 'UTC', afterNotify);
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.advisorProactive}`,
        `work:${QUEUES.advisorProactive}`,
        `work:${QUEUES.advisorProactiveScheduler}`,
        `schedule:${QUEUES.advisorProactiveScheduler}`,
      ]),
    );
    expect(cron).toBe(ADVISOR_PROACTIVE_CRON);

    const on = await household();
    const off = await household({ aiEnabled: false });
    await handlers.get(QUEUES.advisorProactiveScheduler)!([{}]);
    const ids = sent.map((s) => s.data.householdId);
    expect(ids).toContain(on.householdId);
    expect(ids).not.toContain(off.householdId);
    expect(sent.find((s) => s.data.householdId === on.householdId)).toEqual({
      name: QUEUES.advisorProactive,
      data: { householdId: on.householdId },
      options: { singletonKey: on.householdId, retryLimit: 0 },
    });

    // A pass queues push delivery afterwards, and a bad payload fails without it.
    await handlers.get(QUEUES.advisorProactive)!([{ data: { householdId: on.householdId } }]);
    expect(afterNotify).toHaveBeenCalledTimes(1);
    await expect(
      handlers.get(QUEUES.advisorProactive)!([{ data: { householdId: '' } }]),
    ).rejects.toThrow();
    expect(afterNotify).toHaveBeenCalledTimes(1);
  });
});
