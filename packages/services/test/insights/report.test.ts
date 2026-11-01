import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import {
  AiUnavailableError,
  claimPendingReports,
  createCategory,
  ensureMonthlyReports,
  runRecurringDetection,
  ForbiddenError,
  generateReport,
  getReport,
  listReports,
  requestReport,
  ValidationError,
  type AiParseParams,
  type AiParseResult,
  type AnthropicLike,
  type ReportContent,
} from '../../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from '../helpers.js';
import { insightsWorld, PRIOR } from './world.js';

const { aiReport, householdSettings, notification, recurring } = schema;

const MONTH = '2026-09';
const FIRST = '2026-09-01';
const NOW = new Date('2026-10-05T12:00:00Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AVAILABLE = { aiAvailable: true, now: NOW };

const CONTENT: ReportContent = {
  headline: 'A calm month',
  overview: 'Spending stayed close to plan.',
  findings: [{ title: 'Groceries', detail: 'Groceries were the biggest group.', tone: 'neutral' }],
  suggestions: [{ title: 'Keep going', detail: 'Keep the same pace next month.' }],
};

const okResponse = (): AiParseResult => ({
  parsed_output: CONTENT,
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 7,
  },
});

/** A fake client that records every request body it is given. */
function fake(respond: (p: AiParseParams) => AiParseResult | Promise<AiParseResult> = okResponse) {
  const requests: AiParseParams[] = [];
  const client: AnthropicLike = {
    messages: {
      async parse(params) {
        requests.push(params);
        return respond(params);
      },
    },
  };
  return { client, requests };
}

const apiError = (status: number, message = 'secret provider text') =>
  Object.assign(new Error(message), { status });

describe('monthly ai reports', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const logs: string[] = [];
  const logger = {
    info: (m: string) => void logs.push(m),
    warn: (m: string) => void logs.push(m),
  };

  async function world(opts: { timezone?: string; locale?: string; ai?: boolean } = {}) {
    const w = await insightsWorld(t, opts);
    if (opts.ai !== false) {
      await t.owner
        .update(householdSettings)
        .set({ aiEnabled: true })
        .where(eq(householdSettings.householdId, w.ctx.householdId));
    }
    return w;
  }

  /** A month with income and spending, and descriptions that must never reach the model. */
  async function withActivity(w: Awaited<ReturnType<typeof world>>) {
    // six quiet months, so September's groceries are a category spike (an anomaly carrying ids)
    await w.spendIn(w.cats.groceries, PRIOR, 30_000);
    await w.add(w.main, '2026-09-01', 300_000, {
      categoryId: w.cats.salary,
      description: 'SALARY',
    });
    await w.add(w.main, '2026-09-05', -50_000, {
      categoryId: w.cats.groceries,
      description:
        'PAGAMENTO a joao.silva@example.com PT50 0002 0123 1234 5678 9015 4 Maria Fernandes',
    });
  }

  /** A real account row, since `requested_by` references the user table. */
  async function realUser(ctx: Awaited<ReturnType<typeof world>>['ctx']) {
    const id = `user-${randomUUID()}`;
    await t.owner.insert(schema.user).values({ id, name: 'Someone', email: `${id}@example.com` });
    return { ...ctx, userId: id };
  }

  const rowOf = async (householdId: string, month = FIRST) =>
    (
      await t.owner
        .select()
        .from(aiReport)
        .where(and(eq(aiReport.householdId, householdId), eq(aiReport.month, month)))
    )[0]!;

  const insertRow = async (
    householdId: string,
    v: Partial<typeof aiReport.$inferInsert> = {},
  ): Promise<typeof aiReport.$inferSelect> =>
    (
      await t.owner
        .insert(aiReport)
        .values({ householdId, month: FIRST, status: 'pending', locale: 'en', ...v })
        .returning()
    )[0]!;

  /** What the sweep hands to generateReport: the household's due row, leased and counted. */
  const claimOne = async (householdId: string, at: Date = NOW) => {
    const rows = await claimPendingReports(t.db, { now: at, limit: 1000 });
    return rows.find((r) => r.householdId === householdId)!;
  };
  const DAY = 24 * 60 * 60_000;

  /**
   * The test db, except that the transaction of one household fails the way a database fault
   * would. A sweep opens one transaction per household, in id order.
   */
  const failingFor = async (householdId: string) => {
    const ids = (
      await t.db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .orderBy(asc(schema.organization.id))
    ).map((r) => r.id);
    let opened = 0;
    return new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return (...args: Parameters<typeof target.transaction>) => {
            if (ids[opened++] === householdId) throw new RangeError('boom');
            return target.transaction(...args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  const notificationsOf = (householdId: string) =>
    t.owner.select().from(notification).where(eq(notification.householdId, householdId));

  const deps = (client: AnthropicLike) => ({
    db: t.db,
    anthropic: client,
    model: 'claude-test',
    logger,
    now: NOW,
  });

  describe('requestReport', () => {
    it('refuses a viewer', async () => {
      const w = await world();
      await expect(
        requestReport(withRole(w.ctx, 'viewer'), { month: MONTH }, AVAILABLE),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const rows = await t.owner
        .select()
        .from(aiReport)
        .where(eq(aiReport.householdId, w.ctx.householdId));
      expect(rows).toEqual([]);
    });

    it('needs AI on the installation and switched on for the household', async () => {
      const w = await world();
      await expect(
        requestReport(w.ctx, { month: MONTH }, { aiAvailable: false }),
      ).rejects.toBeInstanceOf(AiUnavailableError);
      const off = await world({ ai: false });
      await expect(requestReport(off.ctx, { month: MONTH }, AVAILABLE)).rejects.toBeInstanceOf(
        AiUnavailableError,
      );
    });

    it('creates a pending row for a member, with who asked and the locale', async () => {
      const w = await world({ locale: 'pt-PT' });
      const member = withRole(await realUser(w.ctx), 'member');
      const r = await requestReport(member, { month: MONTH }, AVAILABLE);
      expect(r).toMatchObject({ status: 'pending', regenerations: 0 });
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'pending',
        requestedBy: member.userId,
        locale: 'pt-PT',
        regenerations: 0,
        nextAttemptAt: null,
      });
    });

    it('accepts the first day of the month and rejects anything else', async () => {
      const w = await world();
      w.ctx = await realUser(w.ctx);
      await requestReport(w.ctx, { month: FIRST }, AVAILABLE);
      expect((await rowOf(w.ctx.householdId)).month).toBe(FIRST);
      await expect(requestReport(w.ctx, { month: '2026-13' }, AVAILABLE)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('only reports the last closed month in the household time zone', async () => {
      const w = await world({ timezone: 'Europe/Lisbon' });
      w.ctx = await realUser(w.ctx);
      const at = (month: string, now: string) =>
        requestReport(w.ctx, { month }, { aiAvailable: true, now: new Date(now) });
      // 23:30 on 31 August in Lisbon: August is still open, July is the last closed month
      const before = '2026-08-31T22:30:00Z';
      for (const open of ['2026-08', '2026-09', '2027-01']) {
        await expect(at(open, before)).rejects.toMatchObject({
          name: 'ValidationError',
          code: 'month_not_closed',
        });
      }
      await expect(at('2026-07', before)).resolves.toMatchObject({ status: 'pending' });
      // anything older than the last closed month is refused too
      await expect(at('2026-06', before)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'month_not_allowed',
      });
      // 00:30 on 1 September in Lisbon: August just closed
      await expect(at('2026-08', '2026-08-31T23:30:00Z')).resolves.toMatchObject({
        status: 'pending',
      });
      await expect(at('2026-09', '2026-08-31T23:30:00Z')).rejects.toMatchObject({
        code: 'month_not_closed',
      });
      await expect(at('2026-07', '2026-08-31T23:30:00Z')).rejects.toMatchObject({
        code: 'month_not_allowed',
      });
    });

    it('is a no-op while the report is already pending', async () => {
      const w = await world();
      w.ctx = await realUser(w.ctx);
      await requestReport(w.ctx, { month: MONTH }, AVAILABLE);
      await requestReport(w.ctx, { month: MONTH }, AVAILABLE);
      expect((await rowOf(w.ctx.householdId)).regenerations).toBe(0);
    });

    it('flips a finished report back to pending, at most 3 times', async () => {
      const w = await world();
      const owner = await realUser(w.ctx);
      await insertRow(w.ctx.householdId, { status: 'ready', content: CONTENT, attempts: 2 });
      for (let n = 1; n <= 3; n += 1) {
        await requestReport(owner, { month: MONTH }, AVAILABLE);
        expect(await rowOf(w.ctx.householdId)).toMatchObject({
          status: 'pending',
          regenerations: n,
          attempts: 0,
          requestedBy: owner.userId,
        });
        // the earlier content stays readable until the new one replaces it
        expect((await rowOf(w.ctx.householdId)).content).toEqual(CONTENT);
        await t.owner
          .update(aiReport)
          .set({ status: n === 2 ? 'failed' : 'ready' })
          .where(eq(aiReport.householdId, w.ctx.householdId));
      }
      await expect(requestReport(owner, { month: MONTH }, AVAILABLE)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'regenerate_limit',
      });
      expect(await rowOf(w.ctx.householdId)).toMatchObject({ status: 'ready', regenerations: 3 });
    });
  });

  describe('ensureMonthlyReports', () => {
    const months = async (householdId: string) =>
      (await t.owner.select().from(aiReport).where(eq(aiReport.householdId, householdId))).map(
        (r) => r.month,
      );

    it('inserts the previous month as pending, once, with the household locale', async () => {
      const w = await world({ locale: 'pt-PT' });
      expect(await ensureMonthlyReports(t.db, { now: NOW })).toBeGreaterThanOrEqual(1);
      expect(await rowOf(w.ctx.householdId, FIRST)).toMatchObject({
        status: 'pending',
        locale: 'pt-PT',
        requestedBy: null,
        regenerations: 0,
      });
      await ensureMonthlyReports(t.db, { now: NOW });
      expect(await months(w.ctx.householdId)).toEqual([FIRST]);
    });

    it('leaves an existing row alone and skips households with AI off', async () => {
      const w = await world();
      await insertRow(w.ctx.householdId, { status: 'ready' });
      const off = await world({ ai: false });
      await ensureMonthlyReports(t.db, { now: NOW });
      expect((await rowOf(w.ctx.householdId)).status).toBe('ready');
      expect(await months(off.ctx.householdId)).toEqual([]);
    });

    it('waits until day 3 of the next month, in the household time zone (Lisbon, summer time)', async () => {
      const lisbon = await world({ timezone: 'Europe/Lisbon' });
      const utc = await world({ timezone: 'UTC' });
      // 22:30Z on 2 September is 23:30 in Lisbon: still day 2 there (and in UTC)
      await ensureMonthlyReports(t.db, { now: new Date('2026-09-02T22:30:00Z') });
      expect(await months(lisbon.ctx.householdId)).toEqual([]);
      expect(await months(utc.ctx.householdId)).toEqual([]);
      // 23:30Z is 00:30 on 3 September in Lisbon, but still 2 September in UTC
      await ensureMonthlyReports(t.db, { now: new Date('2026-09-02T23:30:00Z') });
      expect(await months(lisbon.ctx.householdId)).toEqual(['2026-08-01']);
      expect(await months(utc.ctx.householdId)).toEqual([]);
    });

    it('does not report a month on its first two days: the data is still coming in', async () => {
      const w = await world();
      for (const now of ['2026-09-01T00:10:00Z', '2026-09-02T12:00:00Z']) {
        await ensureMonthlyReports(t.db, { now: new Date(now) });
        expect(await months(w.ctx.householdId)).toEqual([]);
      }
      await ensureMonthlyReports(t.db, { now: new Date('2026-09-03T00:10:00Z') });
      expect(await months(w.ctx.householdId)).toEqual(['2026-08-01']);
    });

    it('carries on with the other households when one cannot be processed', async () => {
      const bad = await world();
      const good = await world();
      logs.length = 0;
      const db = await failingFor(bad.ctx.householdId);
      await expect(ensureMonthlyReports(db, { now: NOW, logger })).resolves.toBeGreaterThanOrEqual(
        1,
      );
      expect(await months(bad.ctx.householdId)).toEqual([]);
      expect(await months(good.ctx.householdId)).toEqual([FIRST]);
      // the error class is logged, never the household or its settings
      expect(logs.join('\n')).toMatch(/ai report sweep: a household was skipped \(RangeError\)/);
      expect(logs.join('\n')).not.toContain(bad.ctx.householdId);
    });

    it('rolls over the year', async () => {
      const w = await world();
      await ensureMonthlyReports(t.db, { now: new Date('2027-01-03T00:10:00Z') });
      expect(await months(w.ctx.householdId)).toEqual(['2026-12-01']);
    });
  });

  describe('claimPendingReports', () => {
    it('claims only due pending rows, up to the limit, and leases them', async () => {
      const w = await world();
      const due = await insertRow(w.ctx.householdId, { month: '2026-01-01' });
      await insertRow(w.ctx.householdId, {
        month: '2026-02-01',
        nextAttemptAt: new Date(NOW.getTime() + 60_000),
      });
      await insertRow(w.ctx.householdId, { month: '2026-03-01', status: 'ready' });
      const earlier = await insertRow(w.ctx.householdId, {
        month: '2026-04-01',
        nextAttemptAt: new Date(NOW.getTime() - 60_000),
      });
      const claimed = (await claimPendingReports(t.db, { now: NOW, limit: 100 })).filter(
        (r) => r.householdId === w.ctx.householdId,
      );
      expect(claimed.map((r) => r.id).sort()).toEqual([due.id, earlier.id].sort());
      // leased: pending but not due again for a while
      const after = await rowOf(w.ctx.householdId, '2026-01-01');
      expect(after.status).toBe('pending');
      expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime() + 60_000);
      // the attempt is counted when the row is claimed, not when it fails
      expect(after.attempts).toBe(1);
      expect(claimed.every((r) => r.attempts === 1)).toBe(true);
      expect(await claimPendingReports(t.db, { now: NOW, limit: 100 })).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ id: due.id })]),
      );
    });

    it('stops at the limit across households', async () => {
      const a = await world();
      const b = await world();
      await insertRow(a.ctx.householdId);
      await insertRow(b.ctx.householdId);
      const first = await claimPendingReports(t.db, { now: NOW, limit: 1 });
      expect(first).toHaveLength(1);
    });

    it('carries on with the other households when one cannot be processed', async () => {
      const bad = await world();
      const good = await world();
      await insertRow(bad.ctx.householdId);
      const ok = await insertRow(good.ctx.householdId);
      logs.length = 0;
      const claimed = await claimPendingReports(await failingFor(bad.ctx.householdId), {
        now: NOW,
        limit: 1000,
        logger,
      });
      expect(claimed.map((r) => r.id)).toContain(ok.id);
      expect(claimed.map((r) => r.householdId)).not.toContain(bad.ctx.householdId);
      expect(logs.join('\n')).toMatch(/ai report sweep: a household was skipped \(RangeError\)/);
      expect(logs.join('\n')).not.toContain(bad.ctx.householdId);
    });

    it('never gives the same row to two concurrent sweeps', async () => {
      const w = await world();
      for (let m = 1; m <= 6; m += 1) {
        await insertRow(w.ctx.householdId, { month: `2025-${String(m).padStart(2, '0')}-01` });
      }
      const batches = await Promise.all(
        Array.from({ length: 4 }, () => claimPendingReports(t.db, { now: NOW, limit: 100 })),
      );
      const mine = batches.flatMap((b) => b.filter((r) => r.householdId === w.ctx.householdId));
      expect(mine).toHaveLength(6);
      expect(new Set(mine.map((r) => r.id)).size).toBe(6);
    });
  });

  describe('generateReport', () => {
    async function pendingRow(
      w: Awaited<ReturnType<typeof world>>,
      v: Partial<typeof aiReport.$inferInsert> = {},
    ) {
      return insertRow(w.ctx.householdId, { locale: 'en', ...v });
    }

    it('stores a ready report with content, facts, model and tokens', async () => {
      const w = await world();
      await withActivity(w);
      const { client, requests } = fake();
      const row = await pendingRow(w, { requestedBy: null });
      const result = await generateReport(deps(client), row);
      expect(result).toBe('ready');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: 'claude-test', max_tokens: 4096 });
      expect(requests[0]!.output_config.format.type).toBe('json_schema');
      const stored = await rowOf(w.ctx.householdId);
      expect(stored).toMatchObject({
        status: 'ready',
        content: CONTENT,
        model: 'claude-test',
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
        errorCode: null,
        nextAttemptAt: null,
      });
      // the stored sheet is the full one, with ids for the UI
      expect(JSON.stringify(stored.facts)).toMatch(UUID);
      expect(stored.facts).toMatchObject({ month: MONTH, currency: 'EUR' });
      expect(logs.some((l) => /1200 input and 340 output/.test(l))).toBe(true);
    });

    it('creates one household-wide notification, once, even after a regenerate', async () => {
      const w = await world();
      await withActivity(w);
      const { client } = fake();
      const row = await pendingRow(w);
      await generateReport(deps(client), row);
      const [n] = await notificationsOf(w.ctx.householdId);
      expect(n).toMatchObject({
        kind: 'ai_report_ready',
        userId: null,
        payload: { month: MONTH },
        dedupeKey: `ai_report:${MONTH}`,
      });
      // a regenerate replaces the report without a second notification
      await t.owner.update(aiReport).set({ status: 'pending' }).where(eq(aiReport.id, row.id));
      await generateReport(deps(client), await rowOf(w.ctx.householdId));
      expect(await notificationsOf(w.ctx.householdId)).toHaveLength(1);
    });

    it('skips a month without income or spending: no model call, no tokens, no notice', async () => {
      const w = await world();
      // only a transfer between own accounts
      await w.add(w.main, '2026-09-10', -20_000, {
        categoryId: w.transferId,
        transferGroupId: randomUUID(),
      });
      const { client, requests } = fake();
      const result = await generateReport(deps(client), await pendingRow(w));
      expect(result).toBe('skipped');
      expect(requests).toHaveLength(0);
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'skipped',
        inputTokens: null,
        outputTokens: null,
        model: null,
        content: null,
      });
      expect(await notificationsOf(w.ctx.householdId)).toEqual([]);
    });

    it('sends nothing identifying: no ids, descriptions, emails, IBANs or names', async () => {
      const w = await world();
      await withActivity(w);
      await createCategory(w.ctx, { groupId: w.groups.food, name: 'Gifts for maria@example.com' });
      const { client, requests } = fake();
      await generateReport(deps(client), await pendingRow(w));
      const body = JSON.stringify(requests[0]);
      expect(requests).toHaveLength(1);
      expect(body).not.toMatch(UUID);
      for (const leak of [
        'joao.silva',
        'example.com',
        'PT50',
        '9015',
        'Maria Fernandes',
        'PAGAMENTO',
      ]) {
        expect(body).not.toContain(leak);
      }
      // account and member names are not in the sheet either
      expect(body).not.toContain('Main');
      expect(body).not.toContain('Savings');
      // the figures are
      expect(body).toContain('500.00');
    });

    it('never sends a recurring name taken from a bank description, but does send a confirmed one', async () => {
      const w = await world();
      await withActivity(w);
      for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
        await w.add(w.main, `${m}-12`, -1_500, {
          categoryId: w.cats.dining,
          description: 'TRF P/ Maria Fernandes',
        });
        await w.add(w.main, `${m}-14`, -999, {
          categoryId: w.cats.dining,
          description: 'Gym Club',
        });
      }
      await runRecurringDetection(
        { db: t.db, now: new Date('2026-09-20T10:00:00Z') },
        w.ctx.householdId,
      );
      const items = await t.owner
        .select()
        .from(recurring)
        .where(eq(recurring.householdId, w.ctx.householdId));
      const detected = items.find((r) => r.name.includes('Maria'))!;
      // the detection did turn the description into an item name
      expect(detected).toBeDefined();
      const gym = items.find((r) => r.name.includes('Gym'))!;
      // both are new this month; one gets a price change; the gym was confirmed by the user
      await t.owner
        .update(recurring)
        .set({ createdAt: new Date('2026-09-15T10:00:00Z') })
        .where(eq(recurring.householdId, w.ctx.householdId));
      await t.owner.update(recurring).set({ status: 'confirmed' }).where(eq(recurring.id, gym.id));
      await w.addPriceChange({
        name: detected.name,
        recurringId: detected.id,
        previousAmount: -1_000,
        amount: -1_500,
        date: '2026-09-12',
      });
      const { client, requests } = fake();
      await generateReport(deps(client), await pendingRow(w));
      const body = JSON.stringify(requests[0]);
      expect(requests).toHaveLength(1);
      expect(body).not.toContain('Maria');
      expect(body).not.toContain('Fernandes');
      expect(body).toContain(gym.name);
      const sent = JSON.parse(requests[0]!.messages[0]!.content);
      expect(sent.anomalies.map((a: { type: string }) => a.type)).toEqual(
        expect.arrayContaining(['new_recurring', 'recurring_price_change']),
      );
      // the stored sheet keeps the name for the UI
      expect(JSON.stringify((await rowOf(w.ctx.householdId)).facts)).toContain('Maria');
    });

    it.each([
      ['pt-PT', /português de Portugal/],
      ['en', /Write in English/],
    ])('uses the %s system prompt for the row locale', async (locale, expected) => {
      const w = await world({ locale });
      await withActivity(w);
      const { client, requests } = fake();
      await generateReport(deps(client), await pendingRow(w, { locale }));
      expect(requests[0]!.system.map((b) => b.text).join('\n')).toMatch(expected);
      expect(JSON.parse(requests[0]!.messages[0]!.content)).toMatchObject({ month: MONTH });
    });

    it('keeps the report pending with backoff on 429 and 5xx, then fails after 4 attempts', async () => {
      const w = await world();
      await withActivity(w);
      let status = 429;
      const { client, requests } = fake(() => {
        throw apiError(status);
      });
      const row = await pendingRow(w);
      const backoffMin = [10, 20, 40];
      for (let n = 1; n <= 3; n += 1) {
        status = n === 2 ? 503 : 429;
        const current = await claimOne(w.ctx.householdId, new Date(NOW.getTime() + n * DAY));
        expect(current.attempts).toBe(n);
        expect(await generateReport(deps(client), current)).toBe('retry');
        const stored = await rowOf(w.ctx.householdId);
        expect(stored).toMatchObject({ status: 'pending', attempts: n, inputTokens: null });
        expect(stored.nextAttemptAt!.getTime()).toBe(NOW.getTime() + backoffMin[n - 1]! * 60_000);
      }
      status = 500;
      const last = await claimOne(w.ctx.householdId, new Date(NOW.getTime() + 4 * DAY));
      expect(await generateReport(deps(client), last)).toBe('failed');
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        attempts: 4,
        errorCode: 'provider_unavailable',
        nextAttemptAt: null,
      });
      expect(requests).toHaveLength(4);
      expect(row.id).toBe((await rowOf(w.ctx.householdId)).id);
      expect(await notificationsOf(w.ctx.householdId)).toEqual([]);
    });

    it.each([
      ['a connection error', () => new APIConnectionError({ message: 'down' })],
      ['a timeout', () => new APIConnectionTimeoutError()],
    ])('treats %s like a 5xx: pending with backoff, failed after 4 attempts', async (_n, make) => {
      const w = await world();
      await withActivity(w);
      const { client } = fake(() => {
        throw make();
      });
      await pendingRow(w);
      expect(await generateReport(deps(client), await claimOne(w.ctx.householdId))).toBe('retry');
      const stored = await rowOf(w.ctx.householdId);
      expect(stored).toMatchObject({ status: 'pending', attempts: 1 });
      expect(stored.nextAttemptAt!.getTime()).toBe(NOW.getTime() + 10 * 60_000);
      expect(await generateReport(deps(client), { ...stored, attempts: 4 })).toBe('failed');
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: 'provider_unavailable',
      });
    });

    it('marks a rate limit that never clears as rate_limited', async () => {
      const w = await world();
      await withActivity(w);
      const { client } = fake(() => {
        throw apiError(429);
      });
      await generateReport(deps(client), await pendingRow(w, { attempts: 4 }));
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: 'rate_limited',
      });
    });

    it('stops paying for a row that was claimed more often than the attempt limit', async () => {
      const w = await world();
      await withActivity(w);
      const { client, requests } = fake();
      // claimed a fifth time, e.g. because settling kept failing after earlier model calls
      const row = await pendingRow(w, { attempts: 5 });
      expect(await generateReport(deps(client), row)).toBe('failed');
      expect(requests).toHaveLength(0);
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: 'internal_error',
      });
    });

    it('fails at once on any other error, logging only the class and status', async () => {
      const w = await world();
      await withActivity(w);
      logs.length = 0;
      const { client } = fake(() => {
        throw apiError(400, 'prompt text echoed by the provider');
      });
      expect(await generateReport(deps(client), await pendingRow(w))).toBe('failed');
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: 'provider_error',
        attempts: 0,
      });
      expect(logs.join('\n')).toMatch(/http 400/);
      expect(logs.join('\n')).not.toContain('echoed');
    });

    it.each([
      [
        'a refusal',
        {
          parsed_output: null,
          stop_reason: 'refusal',
          usage: { input_tokens: 9, output_tokens: 0 },
        },
        'refused',
      ],
      [
        'no output',
        {
          parsed_output: null,
          stop_reason: 'max_tokens',
          usage: { input_tokens: 9, output_tokens: 4096 },
        },
        'invalid_output',
      ],
      [
        'an over-long output',
        {
          parsed_output: { ...CONTENT, headline: 'x'.repeat(500) },
          usage: { input_tokens: 9, output_tokens: 9 },
        },
        'invalid_output',
      ],
    ])('fails on %s, keeping the tokens and never the output', async (_name, response, code) => {
      const w = await world();
      await withActivity(w);
      const { client } = fake(() => response as AiParseResult);
      expect(await generateReport(deps(client), await pendingRow(w))).toBe('failed');
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: code,
        content: null,
        inputTokens: 9,
      });
    });

    it('does not call the model when the household switched AI off meanwhile', async () => {
      const w = await world();
      await withActivity(w);
      const row = await pendingRow(w);
      await t.owner
        .update(householdSettings)
        .set({ aiEnabled: false })
        .where(eq(householdSettings.householdId, w.ctx.householdId));
      const { client, requests } = fake();
      expect(await generateReport(deps(client), row)).toBe('failed');
      expect(requests).toHaveLength(0);
      expect(await rowOf(w.ctx.householdId)).toMatchObject({
        status: 'failed',
        errorCode: 'ai_disabled',
      });
    });

    it('leaves a row alone that is no longer pending when the answer arrives', async () => {
      const w = await world();
      await withActivity(w);
      const row = await pendingRow(w);
      const { client } = fake(async () => {
        await t.owner
          .update(aiReport)
          .set({ status: 'failed', errorCode: 'x' })
          .where(eq(aiReport.id, row.id));
        return okResponse();
      });
      expect(await generateReport(deps(client), row)).toBe('superseded');
      expect(await rowOf(w.ctx.householdId)).toMatchObject({ status: 'failed', content: null });
      expect(await notificationsOf(w.ctx.householdId)).toEqual([]);
    });
  });

  describe('concurrent sweeps', () => {
    it('call the model once for a row, however many workers race', async () => {
      const w = await world();
      await withActivity(w);
      await insertRow(w.ctx.householdId);
      const { client, requests } = fake(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return okResponse();
      });
      const sweep = async () => {
        const rows = await claimPendingReports(t.db, { now: NOW, limit: 100 });
        for (const row of rows) {
          if (row.householdId === w.ctx.householdId) await generateReport(deps(client), row);
          else
            await t.owner
              .update(aiReport)
              .set({ nextAttemptAt: null })
              .where(eq(aiReport.id, row.id));
        }
      };
      await Promise.all([sweep(), sweep(), sweep()]);
      expect(requests).toHaveLength(1);
      expect(await rowOf(w.ctx.householdId)).toMatchObject({ status: 'ready' });
      expect(await notificationsOf(w.ctx.householdId)).toHaveLength(1);
    });

    it('a regenerate request during generation does not queue a second call', async () => {
      const w = await world();
      await withActivity(w);
      const owner = await realUser(w.ctx);
      await insertRow(w.ctx.householdId, { status: 'ready' });
      await requestReport(owner, { month: MONTH }, AVAILABLE);
      const { client, requests } = fake(async () => {
        // the user clicks regenerate again while the model is working
        await requestReport(owner, { month: MONTH }, AVAILABLE);
        return okResponse();
      });
      const [claimed] = (await claimPendingReports(t.db, { now: NOW, limit: 100 })).filter(
        (r) => r.householdId === w.ctx.householdId,
      );
      await generateReport(deps(client), claimed!);
      expect(requests).toHaveLength(1);
      expect(await rowOf(w.ctx.householdId)).toMatchObject({ status: 'ready', regenerations: 1 });
      expect(await claimPendingReports(t.db, { now: NOW, limit: 100 })).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ householdId: w.ctx.householdId })]),
      );
    });
  });
  describe('listReports and getReport', () => {
    it('lists newest first, pages with before, and any role can read', async () => {
      const w = await world();
      const other = await world();
      await insertRow(w.ctx.householdId, {
        month: '2026-07-01',
        status: 'ready',
        content: CONTENT,
      });
      await insertRow(w.ctx.householdId, { month: '2026-09-01', status: 'pending' });
      await insertRow(w.ctx.householdId, { month: '2026-08-01', status: 'failed', errorCode: 'x' });
      await insertRow(other.ctx.householdId, { month: '2026-09-01', status: 'ready' });
      const viewer = withRole(w.ctx, 'viewer');
      const all = await listReports(viewer);
      expect(all.map((r) => r.month)).toEqual(['2026-09', '2026-08', '2026-07']);
      expect(await listReports(viewer, { limit: 1 })).toHaveLength(1);
      expect((await listReports(viewer, { before: '2026-09' })).map((r) => r.month)).toEqual([
        '2026-08',
        '2026-07',
      ]);
    });

    it('returns one month or null, and drops content or facts that no longer fit', async () => {
      const w = await world();
      expect(await getReport(w.ctx, { month: MONTH })).toBeNull();
      await insertRow(w.ctx.householdId, {
        status: 'ready',
        content: { headline: 1 },
        facts: { schemaVersion: 0 },
        model: 'claude-test',
      });
      expect(await getReport(w.ctx, { month: MONTH })).toMatchObject({
        month: MONTH,
        status: 'ready',
        content: null,
        facts: null,
        model: 'claude-test',
      });
      await t.owner
        .update(aiReport)
        .set({ content: CONTENT })
        .where(eq(aiReport.householdId, w.ctx.householdId));
      expect((await getReport(w.ctx, { month: MONTH }))?.content).toEqual(CONTENT);
    });

    it('never reads another household', async () => {
      const w = await world();
      const other = await world();
      await insertRow(other.ctx.householdId, { status: 'ready', content: CONTENT });
      expect(await getReport(w.ctx, { month: MONTH })).toBeNull();
      expect(await listReports(w.ctx)).toEqual([]);
    });
  });
});
