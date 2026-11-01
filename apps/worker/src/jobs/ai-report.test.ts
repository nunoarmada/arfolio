import { randomUUID } from 'node:crypto';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '@arfolio/db';
import { createAccount, type AnthropicLike } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';
import { AI_REPORT_CRON, registerAiReport, runAiReportSweep } from './ai-report.js';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorMessage: () => 'error',
}));

const NOW = new Date('2026-10-05T12:00:00Z');
const CONTENT = {
  headline: 'h',
  overview: 'o',
  findings: [],
  suggestions: [],
};

describe('ai-report job', () => {
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
    vi.mocked(log.info).mockClear();
  });

  /** A household with AI on and a pending September report; `activity` adds spending to it. */
  async function household(activity = true): Promise<string> {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner
      .insert(schema.householdSettings)
      .values({ householdId: id, timezone: 'UTC', aiEnabled: true });
    await owner
      .insert(schema.aiReport)
      .values({ householdId: id, month: '2026-09-01', status: 'pending', locale: 'en' });
    if (activity) {
      const account = await createAccount(
        { db, householdId: id, userId: 'u', role: 'owner' },
        { name: 'Main', type: 'checking' },
      );
      await owner.insert(schema.transaction).values({
        householdId: id,
        accountId: account.id,
        dedupeHash: randomUUID(),
        bookingDate: '2026-09-05',
        amount: -5_000,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'x',
        source: 'manual',
      });
    }
    return id;
  }

  const statusOf = async (id: string) =>
    (
      await owner
        .select({ status: schema.aiReport.status })
        .from(schema.aiReport)
        .where(and(eq(schema.aiReport.householdId, id), eq(schema.aiReport.month, '2026-09-01')))
    )[0]?.status;

  const client = (
    parse: AnthropicLike['messages']['parse'] = async () => ({
      parsed_output: CONTENT,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ) => ({ anthropic: { messages: { parse } } as AnthropicLike, parse: vi.fn(parse) });

  it('generates the pending reports and asks for push delivery once', async () => {
    const a = await household();
    const b = await household();
    const parse = vi.fn(client().parse);
    const afterNotify = vi.fn(async () => {});
    const result = await runAiReportSweep(
      { db, anthropic: { messages: { parse } }, model: 'm' },
      afterNotify,
      NOW,
    );
    expect(result.ready).toBeGreaterThanOrEqual(2);
    expect(await statusOf(a)).toBe('ready');
    expect(await statusOf(b)).toBe('ready');
    expect(afterNotify).toHaveBeenCalledTimes(1);
  });

  it('does not ask for push delivery when nothing became ready', async () => {
    const quiet = await household(false);
    const busy = await household();
    const afterNotify = vi.fn(async () => {});
    const failing = client(async () => {
      throw Object.assign(new Error('rate'), { status: 429 });
    });
    await runAiReportSweep({ db, anthropic: failing.anthropic, model: 'm' }, afterNotify, NOW);
    expect(await statusOf(quiet)).toBe('skipped');
    expect(await statusOf(busy)).toBe('pending'); // rate limited: retried later
    expect(afterNotify).not.toHaveBeenCalled();
  });

  it('inserts the previous month for households that have none, then reports it', async () => {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner
      .insert(schema.householdSettings)
      .values({ householdId: id, timezone: 'UTC', aiEnabled: true });
    await runAiReportSweep({ db, anthropic: client().anthropic, model: 'm' }, async () => {}, NOW);
    expect(await statusOf(id)).toBe('skipped'); // no activity: skipped, not left pending
  });

  it('registers the queue, the job and the 5 minute schedule', async () => {
    const calls: string[] = [];
    let cron = '';
    let options: unknown;
    const boss = {
      createQueue: async (n: string) => void calls.push(`createQueue:${n}`),
      work: async (n: string) => void calls.push(`work:${n}`),
      schedule: async (n: string, c: string, _d: unknown, o: unknown) => {
        calls.push(`schedule:${n}`);
        cron = c;
        options = o;
      },
    } as unknown as PgBoss;
    await registerAiReport(
      boss,
      {
        db,
        getConfig: async () => makeConfig({ anthropicApiKey: 'k' }),
        getAnthropic: () => client().anthropic,
      },
      'Europe/Lisbon',
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        `createQueue:${QUEUES.aiReport}`,
        `work:${QUEUES.aiReport}`,
        `schedule:${QUEUES.aiReport}`,
      ]),
    );
    expect(cron).toBe(AI_REPORT_CRON);
    expect(AI_REPORT_CRON).toBe('*/5 * * * *');
    expect(options).toEqual({ tz: 'Europe/Lisbon' });
  });

  const fakeBoss = () => {
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    const boss = {
      createQueue: async () => {},
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) =>
        void handlers.set(n, h),
      schedule: async () => {},
    } as unknown as PgBoss;
    return { boss, handlers };
  };

  it('without an API key it registers, logs once while off and does nothing', async () => {
    const id = await household();
    const { boss, handlers } = fakeBoss();
    vi.mocked(log.info).mockClear();
    const afterNotify = vi.fn(async () => {});
    await registerAiReport(
      boss,
      { db, getConfig: async () => makeConfig(), getAnthropic: () => null },
      'UTC',
      afterNotify,
    );
    const run = handlers.get(QUEUES.aiReport)!;
    await run([{}]);
    await run([{}]);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info).mock.calls[0]![0]).toContain('ANTHROPIC_API_KEY is not set');
    expect(await statusOf(id)).toBe('pending');
    expect(afterNotify).not.toHaveBeenCalled();
  });

  it('starts generating once a key appears, with the report model of that run', async () => {
    const id = await household();
    const { boss, handlers } = fakeBoss();
    let cfg = makeConfig();
    const models: string[] = [];
    const reportClient: AnthropicLike = {
      messages: {
        parse: async (params) => {
          models.push(params.model);
          return { parsed_output: CONTENT, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    await registerAiReport(
      boss,
      {
        db,
        getConfig: async () => cfg,
        getAnthropic: (c) => (c.anthropicApiKey.value ? reportClient : null),
      },
      'UTC',
    );
    const run = handlers.get(QUEUES.aiReport)!;
    await run([{}]);
    expect(models).toEqual([]);
    expect(await statusOf(id)).toBe('pending');
    cfg = makeConfig({ anthropicApiKey: 'sk-new', reportModel: 'report-v2' });
    await run([{}]);
    expect(models).toContain('report-v2');
    expect(await statusOf(id)).toBe('ready');
  });

  it('an unreadable stored key skips the sweep without throwing', async () => {
    const { boss, handlers } = fakeBoss();
    vi.mocked(log.info).mockClear();
    await registerAiReport(
      boss,
      { db, getConfig: async () => makeConfig({ unreadableKey: true }), getAnthropic: () => null },
      'UTC',
    );
    await expect(handlers.get(QUEUES.aiReport)!([{}])).resolves.toBeUndefined();
    expect(vi.mocked(log.info).mock.calls[0]![0]).toContain('cannot be decrypted');
  });
});
