import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import type { AnthropicLike } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';
import type { PgBoss } from 'pg-boss';
import { AI_MAX_RUN_MS } from '@arfolio/services';
import {
  AI_CATEGORISE_EXPIRE_SECONDS,
  AI_CHECK_CRON,
  AI_PAUSE_MS,
  createAiPause,
  enqueueAiCategorise,
  enqueueAiCheck,
  enqueueAiSweep,
  registerAiCategorise,
  runAiCategoriseJob,
} from './ai-categorise.js';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('ai-categorise jobs', () => {
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

  async function household(aiEnabled: boolean): Promise<string> {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId: id, aiEnabled });
    return id;
  }

  it('categorises the household named in the payload', async () => {
    const householdId = await household(true);
    const [group] = await owner
      .insert(schema.categoryGroup)
      .values({ householdId, name: 'G', kind: 'expense' })
      .returning();
    const [cat] = await owner
      .insert(schema.category)
      .values({ householdId, groupId: group!.id, name: 'Food' })
      .returning();
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId, name: 'A', type: 'checking', currency: 'EUR' })
      .returning();
    const [row] = await owner
      .insert(schema.transaction)
      .values({
        householdId,
        accountId: account!.id,
        dedupeHash: 'h',
        bookingDate: '2026-10-05',
        amount: -500,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'CAFE',
        source: 'connector',
        needsReview: true,
      })
      .returning();
    const anthropic: AnthropicLike = {
      messages: {
        parse: async () => ({
          parsed_output: { items: [{ id: 't1', categoryId: 'c1', confidence: 0.95 }] },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    };

    await runAiCategoriseJob({ db, anthropic, model: 'm' }, { householdId });

    const [stored] = await owner
      .select()
      .from(schema.transaction)
      .where(eq(schema.transaction.id, row!.id));
    expect(stored).toMatchObject({ categoryId: cat!.id, categorisedBy: 'ai', needsReview: false });
  });

  async function waitingRow(householdId: string): Promise<void> {
    const [account] = await owner
      .insert(schema.financialAccount)
      .values({ householdId, name: 'A', type: 'checking', currency: 'EUR' })
      .returning();
    await owner.insert(schema.transaction).values({
      householdId,
      accountId: account!.id,
      dedupeHash: `h-${randomUUID()}`,
      bookingDate: '2026-10-05',
      amount: -500,
      currency: 'EUR',
      status: 'booked',
      rawDescription: 'CAFE',
      source: 'connector',
      needsReview: true,
    });
  }

  it('pauses a household whose run hit a rate limit or a broken key', async () => {
    const householdId = await household(true);
    await owner
      .insert(schema.categoryGroup)
      .values({ householdId, name: 'G', kind: 'expense' })
      .returning()
      .then(([g]) =>
        owner.insert(schema.category).values({ householdId, groupId: g!.id, name: 'Food' }),
      );
    await waitingRow(householdId);
    const anthropic: AnthropicLike = {
      messages: {
        parse: async () => {
          throw Object.assign(new Error('limited'), { status: 429 });
        },
      },
    };
    const pause = createAiPause();
    await runAiCategoriseJob({ db, anthropic, model: 'm' }, { householdId }, pause);
    expect(pause.isPaused(householdId)).toBe(true);
  });

  it('a pause ends after its time', () => {
    let now = 1_000;
    const pause = createAiPause(() => now);
    pause.pause('hh_1');
    expect(pause.isPaused('hh_1')).toBe(true);
    expect(pause.isPaused('hh_2')).toBe(false);
    now += AI_PAUSE_MS;
    expect(pause.isPaused('hh_1')).toBe(false);
  });

  it('checks every minute and queues only households with waiting rows, unless paused', async () => {
    expect(AI_CHECK_CRON).toBe('* * * * *');
    const busy = await household(true);
    const idle = await household(true);
    const off = await household(false);
    const paused = await household(true);
    await waitingRow(busy);
    await waitingRow(off);
    await waitingRow(paused);
    const pause = createAiPause();
    pause.pause(paused);
    const sent: Array<{ name: string; householdId: string }> = [];
    await enqueueAiCheck(
      db,
      async (name, data) => {
        sent.push({ name, householdId: (data as { householdId: string }).householdId });
      },
      pause,
    );
    const ids = sent.map((s) => s.householdId);
    expect(ids).toContain(busy);
    expect(ids).not.toContain(idle);
    expect(ids).not.toContain(off);
    expect(ids).not.toContain(paused);
    expect(sent.every((s) => s.name === QUEUES.aiCategorise)).toBe(true);
  });

  it('rejects a malformed payload', async () => {
    await expect(
      runAiCategoriseJob({ db, anthropic: null, model: 'm' }, { householdId: '' }),
    ).rejects.toThrow(/Invalid ai-categorise job/);
  });

  it('queues a singleton job per household', async () => {
    const sent: unknown[][] = [];
    await enqueueAiCategorise(async (...args) => void sent.push(args), 'hh_1');
    expect(sent).toEqual([
      [QUEUES.aiCategorise, { householdId: 'hh_1' }, { singletonKey: 'hh_1', retryLimit: 0 }],
    ]);
  });

  it('sweeps only households with AI enabled', async () => {
    const on = await household(true);
    const off = await household(false);
    const sent: Array<{ name: string; data: { householdId: string } }> = [];
    await enqueueAiSweep(db, async (name, data) => {
      sent.push({ name, data: data as { householdId: string } });
    });
    const ids = sent.map((s) => s.data.householdId);
    expect(ids).toContain(on);
    expect(ids).not.toContain(off);
    expect(sent.every((s) => s.name === QUEUES.aiCategorise)).toBe(true);
  });

  describe('registerAiCategorise', () => {
    const fakeBoss = () => {
      const calls: string[] = [];
      const queueOptions = new Map<string, unknown>();
      const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
      const boss = {
        createQueue: async (n: string, o: unknown) => {
          calls.push(`createQueue:${n}`);
          queueOptions.set(n, o);
        },
        work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => {
          calls.push(`work:${n}`);
          handlers.set(n, h);
        },
        schedule: async (n: string) => void calls.push(`schedule:${n}`),
        unschedule: async (n: string) => void calls.push(`unschedule:${n}`),
        send: async (n: string) => void calls.push(`send:${n}`),
        updateQueue: async (n: string, o: unknown) => {
          calls.push(`updateQueue:${n}`);
          queueOptions.set(`update:${n}`, o);
        },
      } as unknown as PgBoss;
      return { boss, calls, queueOptions, handlers };
    };
    const idleClient: AnthropicLike = {
      messages: {
        parse: async () => ({
          parsed_output: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      },
    };

    it('registers the job and schedules the sweep when a key is configured', async () => {
      const { boss, calls, queueOptions } = fakeBoss();
      const enqueue = await registerAiCategorise(
        boss,
        {
          db,
          getConfig: async () => makeConfig({ anthropicApiKey: 'k' }),
          getAnthropic: () => idleClient,
        },
        'UTC',
      );
      expect(calls).toContain(`schedule:${QUEUES.aiSweep}`);
      expect(calls).toContain(`schedule:${QUEUES.aiCheck}`);
      // A run must end before its job expires, or the check would start a second one.
      expect(queueOptions.get(QUEUES.aiCategorise)).toMatchObject({
        policy: 'stately',
        expireInSeconds: AI_CATEGORISE_EXPIRE_SECONDS,
      });
      // An existing queue keeps its options on createQueue: the expiry is updated too.
      expect(queueOptions.get(`update:${QUEUES.aiCategorise}`)).toEqual({
        expireInSeconds: AI_CATEGORISE_EXPIRE_SECONDS,
      });
      expect(AI_CATEGORISE_EXPIRE_SECONDS * 1000).toBeGreaterThan(AI_MAX_RUN_MS + 10 * 60_000);
      expect(calls).not.toContain(`unschedule:${QUEUES.aiSweep}`);
      await enqueue('hh_1');
      expect(calls).toContain(`send:${QUEUES.aiCategorise}`);
    });

    it('without a key it still registers, enqueues nothing and logs the off line once', async () => {
      const { boss, calls, handlers } = fakeBoss();
      vi.mocked(log.info).mockClear();
      const enqueue = await registerAiCategorise(
        boss,
        { db, getConfig: async () => makeConfig(), getAnthropic: () => null },
        'UTC',
      );
      expect(calls).toContain(`schedule:${QUEUES.aiCheck}`);
      expect(calls).not.toContain(`unschedule:${QUEUES.aiCheck}`);
      const sendsBefore = calls.filter((c) => c.startsWith('send:')).length;
      await enqueue('hh_1');
      await handlers.get(QUEUES.aiCheck)!([{}]);
      await handlers.get(QUEUES.aiSweep)!([{}]);
      expect(calls.filter((c) => c.startsWith('send:'))).toHaveLength(sendsBefore);
      const off = vi.mocked(log.info).mock.calls.filter(([m]) => String(m).includes('is off'));
      expect(off).toHaveLength(1);
      expect(String(off[0]![0])).toContain('ANTHROPIC_API_KEY is not set');
    });

    async function categorisableHousehold(): Promise<string> {
      const householdId = await household(true);
      const [g] = await owner
        .insert(schema.categoryGroup)
        .values({ householdId, name: 'G', kind: 'expense' })
        .returning();
      await owner.insert(schema.category).values({ householdId, groupId: g!.id, name: 'Food' });
      await waitingRow(householdId);
      return householdId;
    }

    it('skips while there is no key and runs once one appears, without a restart', async () => {
      const householdId = await categorisableHousehold();
      const { boss, handlers } = fakeBoss();
      let cfg = makeConfig();
      const parse = vi.fn(idleClient.messages.parse);
      const client: AnthropicLike = { messages: { parse } };
      await registerAiCategorise(
        boss,
        {
          db,
          getConfig: async () => cfg,
          getAnthropic: (c) => (c.anthropicApiKey.value ? client : null),
        },
        'UTC',
      );
      const run = handlers.get(QUEUES.aiCategorise)!;
      await run([{ data: { householdId } }]);
      expect(parse).not.toHaveBeenCalled();
      cfg = makeConfig({ anthropicApiKey: 'sk-new' });
      await run([{ data: { householdId } }]);
      expect(parse).toHaveBeenCalled();
    });

    it('uses the categorisation model of the config of that run', async () => {
      const householdId = await categorisableHousehold();
      const { boss, handlers } = fakeBoss();
      let cfg = makeConfig({ anthropicApiKey: 'k', categorisationModel: 'model-a' });
      const models: string[] = [];
      const client: AnthropicLike = {
        messages: {
          parse: async (params) => {
            models.push(params.model);
            return { parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } };
          },
        },
      };
      await registerAiCategorise(
        boss,
        { db, getConfig: async () => cfg, getAnthropic: () => client },
        'UTC',
      );
      const run = handlers.get(QUEUES.aiCategorise)!;
      await run([{ data: { householdId } }]);
      cfg = makeConfig({ anthropicApiKey: 'k', categorisationModel: 'model-b' });
      await run([{ data: { householdId } }]);
      expect(models.slice(0, 1)).toEqual(['model-a']);
      expect(models.at(-1)).toBe('model-b');
    });

    it('an unreadable stored key skips the job without throwing and says why', async () => {
      const householdId = await categorisableHousehold();
      const { boss, handlers } = fakeBoss();
      vi.mocked(log.info).mockClear();
      const parse = vi.fn(idleClient.messages.parse);
      await registerAiCategorise(
        boss,
        {
          db,
          getConfig: async () => makeConfig({ unreadableKey: true }),
          getAnthropic: () => null,
        },
        'UTC',
      );
      await expect(
        handlers.get(QUEUES.aiCategorise)!([{ data: { householdId } }]),
      ).resolves.toBeUndefined();
      expect(parse).not.toHaveBeenCalled();
      const off = vi.mocked(log.info).mock.calls.map(([m]) => String(m));
      expect(off.some((m) => m.includes('cannot be decrypted'))).toBe(true);
    });
  });
});
