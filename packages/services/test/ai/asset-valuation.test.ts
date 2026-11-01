import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { schema } from '@arfolio/db';
import {
  claimDueAssetValuations,
  createAccount,
  DEFAULT_VALUATION_PORTALS,
  estimateAssetValue,
  markAssetValuationFailed,
  type AnthropicCreateLike,
  type DueAsset,
  type ServiceCtx,
} from '../../src/index.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';

const { asset, assetValuation, householdSettings } = schema;

// Lisbon is UTC+0 in winter, so the household day is 2026-10-31; in Tokyo (UTC+9) it is 2026-11-01.
const NOW = new Date('2026-10-31T23:30:00Z');
const HOUR = 3_600_000;
const TZ = 'Europe/Lisbon';
const MODEL = 'test-model';

const HOUSE = {
  propertyType: 'apartment',
  typology: 'T2',
  municipality: 'Lisboa',
  areaM2: 85,
} as const;
const CAR = {
  vehicleType: 'car',
  make: 'Renault',
  model: 'Clio',
  year: 2019,
  mileageKm: 60_000,
} as const;

const ANSWER = {
  value: 312_500.4,
  low: 290_000,
  high: 330_000,
  confidence: 'medium',
  rationale: 'Comparable T2 listings in Lisboa ask about 4 000 EUR per m2, less a usual discount.',
  sources: [{ title: 'T2 em Lisboa', url: 'https://www.idealista.pt/imovel/1/' }],
  reason: null,
};

type Block = Record<string, unknown>;

function message(content: Block[], stop_reason: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    },
  } as unknown as Anthropic.Message;
}

const recorded = (input: unknown) =>
  message(
    [
      { type: 'text', text: 'Looking at listings.', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'record_estimate', input },
    ],
    'tool_use',
  );

/** A fake client that answers with the canned messages in order and records every request. */
function fake(...responses: Array<Anthropic.Message | Error | (() => Promise<Anthropic.Message>)>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicCreateLike = {
    messages: {
      async create(params) {
        // a deep copy, so a later mutation of the caller's arrays cannot change what was sent
        requests.push(structuredClone(params));
        const next = responses.shift();
        if (!next) throw new Error('unexpected extra call');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
      },
    },
  };
  return { client, requests };
}

describe('AI asset valuation', () => {
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

  async function household(opts: { ai?: boolean; timezone?: string } = {}): Promise<ServiceCtx> {
    const ctx = await t.household();
    await t.owner
      .update(householdSettings)
      .set({ aiEnabled: opts.ai ?? true, timezone: opts.timezone ?? TZ })
      .where(eq(householdSettings.householdId, ctx.householdId));
    return ctx;
  }

  async function addAsset(
    ctx: ServiceCtx,
    values: Partial<typeof asset.$inferInsert> = {},
  ): Promise<typeof asset.$inferSelect> {
    const [row] = await t.owner
      .insert(asset)
      .values({
        householdId: ctx.householdId,
        kind: 'real_estate',
        name: 'Flat',
        currency: 'EUR',
        details: { ...HOUSE },
        aiValuation: true,
        ...values,
      })
      .returning();
    return row!;
  }

  async function addValuation(
    ctx: ServiceCtx,
    assetId: string,
    asOf: string,
    value: number,
    method: 'manual' | 'ai' = 'manual',
  ) {
    await t.owner
      .insert(assetValuation)
      .values({ householdId: ctx.householdId, assetId, asOf, value, method });
  }

  const assetRow = async (id: string) =>
    (await t.owner.select().from(asset).where(eq(asset.id, id)))[0]!;
  const valuationsOf = async (id: string) =>
    t.owner.select().from(assetValuation).where(eq(assetValuation.assetId, id));

  /** Claims with room for everything due and returns the claim of `assetId`, if any. */
  async function claim(assetId: string, now = NOW): Promise<DueAsset | undefined> {
    const due = await claimDueAssetValuations(t.db, { now, limit: 1_000, tz: 'UTC', logger });
    return due.find((d) => d.assetId === assetId);
  }

  const deps = (client: AnthropicCreateLike) => ({
    db: t.db,
    anthropic: client,
    model: MODEL,
    portals: DEFAULT_VALUATION_PORTALS,
    logger,
    now: NOW,
    tz: 'UTC',
  });

  describe('claimDueAssetValuations', () => {
    it('claims a requested asset with its last three values and stamps the attempt', async () => {
      const ctx = await household();
      const a = await addAsset(ctx, { aiRequestedAt: new Date(NOW.getTime() - HOUR) });
      for (const [asOf, value] of [
        ['2026-06-01', 100],
        ['2026-07-01', 200],
        ['2026-08-01', 300],
        ['2026-09-01', 400],
      ] as const) {
        await addValuation(ctx, a.id, asOf, value);
      }

      const due = await claim(a.id);
      expect(due).toEqual({
        householdId: ctx.householdId,
        assetId: a.id,
        kind: 'real_estate',
        currency: 'EUR',
        details: HOUSE,
        claimedAt: NOW,
        history: [
          { asOf: '2026-09-01', value: 400, method: 'manual' },
          { asOf: '2026-08-01', value: 300, method: 'manual' },
          { asOf: '2026-07-01', value: 200, method: 'manual' },
        ],
      });
      expect((await assetRow(a.id)).aiAttemptedAt).toEqual(NOW);
      // claimed: not due again straight away
      expect(await claim(a.id)).toBeUndefined();
    });

    it('claims an asset without an AI value this month even with no request', async () => {
      const ctx = await household();
      const a = await addAsset(ctx);
      await addValuation(ctx, a.id, '2026-09-30', 1_000, 'ai');
      expect(await claim(a.id)).toBeDefined();
    });

    it('skips an asset already estimated this month in the household time zone', async () => {
      const ctx = await household();
      const a = await addAsset(ctx);
      await addValuation(ctx, a.id, '2026-10-01', 1_000, 'ai');
      expect(await claim(a.id)).toBeUndefined();

      // In Tokyo it is already November: October's estimate is last month's.
      const tokyo = await household({ timezone: 'Asia/Tokyo' });
      const b = await addAsset(tokyo);
      await addValuation(tokyo, b.id, '2026-10-01', 1_000, 'ai');
      expect(await claim(b.id)).toBeDefined();
    });

    it('skips linked, archived, switched-off and non-eligible assets', async () => {
      const ctx = await household();
      const account = await createAccount(ctx, { name: 'Savings', type: 'savings' });
      const linked = await addAsset(ctx, { kind: 'other', details: null, accountId: account.id });
      const archived = await addAsset(ctx, { archived: true });
      const off = await addAsset(ctx, { aiValuation: false });
      const cash = await addAsset(ctx, { kind: 'cash', details: null });
      for (const a of [linked, archived, off, cash]) expect(await claim(a.id)).toBeUndefined();
    });

    it('skips every asset of a household with AI off', async () => {
      const ctx = await household({ ai: false });
      const a = await addAsset(ctx, { aiRequestedAt: NOW });
      expect(await claim(a.id)).toBeUndefined();
    });

    it('waits 12 hours after an attempt unless a newer request came in', async () => {
      const ctx = await household();
      const recent = await addAsset(ctx, { aiAttemptedAt: new Date(NOW.getTime() - HOUR) });
      const old = await addAsset(ctx, { aiAttemptedAt: new Date(NOW.getTime() - 13 * HOUR) });
      const asked = await addAsset(ctx, {
        aiAttemptedAt: new Date(NOW.getTime() - HOUR),
        aiRequestedAt: new Date(NOW.getTime() - HOUR / 2),
      });
      const due = await claimDueAssetValuations(t.db, { now: NOW, limit: 1_000, tz: 'UTC' });
      const ids = due.map((d) => d.assetId);
      expect(ids).not.toContain(recent.id);
      expect(ids).toContain(old.id);
      expect(ids).toContain(asked.id);
    });

    it('settles the month after an answered failure; only api_error retries after 12 hours', async () => {
      const ctx = await household();
      const attempted = new Date(NOW.getTime() - 13 * HOUR); // earlier the same month
      const noAnswer = await addAsset(ctx, { aiAttemptedAt: attempted, aiLastError: 'no_answer' });
      const noData = await addAsset(ctx, {
        aiAttemptedAt: attempted,
        aiLastError: 'insufficient_data',
      });
      const apiError = await addAsset(ctx, { aiAttemptedAt: attempted, aiLastError: 'api_error' });
      const askedAgain = await addAsset(ctx, {
        aiAttemptedAt: attempted,
        aiLastError: 'no_answer',
        aiRequestedAt: new Date(NOW.getTime() - HOUR),
      });
      const lastMonth = await addAsset(ctx, {
        aiAttemptedAt: new Date('2026-09-30T12:00:00Z'),
        aiLastError: 'no_answer',
      });
      const due = await claimDueAssetValuations(t.db, { now: NOW, limit: 1_000, tz: 'UTC' });
      const ids = due.map((d) => d.assetId);
      expect(ids).not.toContain(noAnswer.id);
      expect(ids).not.toContain(noData.id);
      expect(ids).toContain(apiError.id);
      expect(ids).toContain(askedAgain.id);
      expect(ids).toContain(lastMonth.id);
    });

    it('counts a manual value this month as the month value, unless asked for', async () => {
      const ctx = await household();
      const manual = await addAsset(ctx);
      await addValuation(ctx, manual.id, '2026-10-12', 1_000, 'manual');
      expect(await claim(manual.id)).toBeUndefined();

      const asked = await addAsset(ctx, { aiRequestedAt: new Date(NOW.getTime() - HOUR) });
      await addValuation(ctx, asked.id, '2026-10-12', 1_000, 'manual');
      expect(await claim(asked.id)).toBeDefined();
    });

    it('stops at the limit', async () => {
      const ctx = await household();
      await addAsset(ctx);
      await addAsset(ctx);
      const due = await claimDueAssetValuations(t.db, { now: NOW, limit: 1, tz: 'UTC' });
      expect(due).toHaveLength(1);
    });
  });

  describe('estimateAssetValue', () => {
    async function claimed(values: Partial<typeof asset.$inferInsert> = {}, ai = true) {
      const ctx = await household({ ai });
      const a = await addAsset(ctx, { aiRequestedAt: NOW, aiLastError: 'api_error', ...values });
      const due = await claim(a.id);
      if (!due) throw new Error('asset was not claimed');
      return { ctx, a, due };
    }

    it('stores the answer as an ai valuation for today, in minor units with the range', async () => {
      const { ctx, a, due } = await claimed();
      const { client, requests } = fake(recorded(ANSWER));

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');

      expect(requests).toHaveLength(1);
      const [v] = await valuationsOf(a.id);
      expect(v).toMatchObject({
        householdId: ctx.householdId,
        asOf: '2026-10-31',
        value: 31_250_040,
        method: 'ai',
        note: ANSWER.rationale,
        estimate: {
          low: 29_000_000,
          high: 33_000_000,
          confidence: 'medium',
          sources: ANSWER.sources,
        },
      });
      expect(await assetRow(a.id)).toMatchObject({ aiRequestedAt: null, aiLastError: null });
    });

    it('uses the household time zone for today', async () => {
      const { a, due } = await claimed();
      await t.owner
        .update(householdSettings)
        .set({ timezone: 'Asia/Tokyo' })
        .where(eq(householdSettings.householdId, due.householdId));
      const { client } = fake(recorded(ANSWER));
      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect((await valuationsOf(a.id))[0]!.asOf).toBe('2026-11-01');
    });

    it('sends portal-restricted web tools, the strict record tool and the asset facts', async () => {
      const { due } = await claimed();
      const { client, requests } = fake(recorded(ANSWER));
      await estimateAssetValue(deps(client), due);

      const req = requests[0]!;
      expect(req).toMatchObject({
        model: MODEL,
        max_tokens: 16_000,
        tool_choice: { type: 'auto' },
        output_config: { effort: 'medium' },
      });
      expect(req).not.toHaveProperty('thinking');
      expect(req).not.toHaveProperty('temperature');
      expect(req.output_config).not.toHaveProperty('format');
      const domains = ['idealista.pt', 'imovirtual.com', 'casa.sapo.pt', 'supercasa.pt'];
      expect(req.tools).toEqual([
        { type: 'web_search_20260209', name: 'web_search', max_uses: 6, allowed_domains: domains },
        {
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: 6,
          max_content_tokens: 15_000,
          allowed_domains: domains,
        },
        expect.objectContaining({ name: 'record_estimate', strict: true }),
      ]);
      const record = req.tools![2] as Anthropic.Tool;
      expect(record.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect([...(record.input_schema.required ?? [])].sort()).toEqual(
        Object.keys(record.input_schema.properties!).sort(),
      );

      // the system prompt is cacheable and carries no date
      const system = req.system as Anthropic.TextBlockParam[];
      expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
      expect(JSON.stringify(system)).not.toMatch(/2026/);

      expect(req.messages).toHaveLength(1);
      const user = JSON.parse(req.messages[0]!.content as string);
      expect(user).toEqual({
        kind: 'real_estate',
        details: HOUSE,
        currency: 'EUR',
        today: '2026-10-31',
        history: [],
      });
    });

    it('restricts a vehicle to the car portals and leaves art and collectibles unrestricted', async () => {
      const car = await claimed({ kind: 'vehicle', details: { ...CAR } });
      const art = await claimed({
        kind: 'other',
        details: { category: 'art', description: 'Oil on canvas, 1960s' },
      });
      const watch = await claimed({
        kind: 'other',
        details: { category: 'watch', brand: 'Omega', model: 'Speedmaster' },
      });
      const collectible = await claimed({
        kind: 'other',
        details: { category: 'collectible', description: 'First edition comic, 1938' },
      });
      const { client, requests } = fake(
        recorded(ANSWER),
        recorded(ANSWER),
        recorded(ANSWER),
        recorded(ANSWER),
      );
      await estimateAssetValue(deps(client), car.due);
      await estimateAssetValue(deps(client), art.due);
      await estimateAssetValue(deps(client), watch.due);
      await estimateAssetValue(deps(client), collectible.due);

      const search = (i: number) => requests[i]!.tools![0] as Anthropic.WebSearchTool20260209;
      expect(search(0).allowed_domains).toEqual([
        'standvirtual.com',
        'olx.pt',
        'autoscout24.pt',
        'custojusto.pt',
      ]);
      expect(search(1)).not.toHaveProperty('allowed_domains');
      expect(search(2).allowed_domains).toContain('chrono24.pt');
      expect(search(3)).not.toHaveProperty('allowed_domains');
      expect(requests[3]!.tools![1]).not.toHaveProperty('allowed_domains');
    });

    it('passes the history to the model in major units', async () => {
      const ctx = await household();
      const a = await addAsset(ctx, { aiRequestedAt: NOW });
      await addValuation(ctx, a.id, '2026-09-01', 25_000_050);
      const due = (await claim(a.id))!;
      const { client, requests } = fake(recorded(ANSWER));
      await estimateAssetValue(deps(client), due);
      expect(JSON.parse(requests[0]!.messages[0]!.content as string).history).toEqual([
        { asOf: '2026-09-01', value: 250_000.5, method: 'manual' },
      ]);
    });

    it('converts with the minor digits of the asset currency', async () => {
      const ctx = await household();
      const a = await addAsset(ctx, { currency: 'JPY', aiRequestedAt: NOW });
      await addValuation(ctx, a.id, '2026-09-01', 900);
      const due = (await claim(a.id))!;
      const { client, requests } = fake(
        recorded({ ...ANSWER, value: 1000, low: 800.4, high: 1200 }),
      );

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect(JSON.parse(requests[0]!.messages[0]!.content as string).history).toEqual([
        { asOf: '2026-09-01', value: 900, method: 'manual' },
      ]);
      const [v] = (await valuationsOf(a.id)).filter((r) => r.method === 'ai');
      expect(v).toMatchObject({ value: 1000, estimate: { low: 800, high: 1200 } });
    });

    it('keeps a manual value recorded the same day', async () => {
      const { ctx, a, due } = await claimed();
      await addValuation(ctx, a.id, '2026-10-31', 12_345);
      const { client } = fake(recorded(ANSWER));

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      const rows = await valuationsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ value: 12_345, method: 'manual', estimate: null });
    });

    it('replaces an earlier ai value of the same day', async () => {
      const { ctx, a, due } = await claimed();
      await addValuation(ctx, a.id, '2026-10-31', 12_345, 'ai');
      const { client } = fake(recorded(ANSWER));
      await estimateAssetValue(deps(client), due);
      const rows = await valuationsOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ value: 31_250_040, method: 'ai' });
    });

    it('resumes a paused turn with the assistant content and no extra text', async () => {
      const { a, due } = await claimed();
      const paused = message(
        [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }],
        'pause_turn',
      );
      const { client, requests } = fake(paused, recorded(ANSWER));

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect(requests).toHaveLength(2);
      expect(requests[1]!.messages).toEqual([
        requests[0]!.messages[0],
        { role: 'assistant', content: paused.content },
      ]);
      expect(requests[1]!.system).toEqual(requests[0]!.system);
      expect(requests[1]!.tools).toEqual(requests[0]!.tools);
      expect(await valuationsOf(a.id)).toHaveLength(1);
    });

    it('accumulates the assistant content of every pause in the next request', async () => {
      const { due } = await claimed();
      const first = message(
        [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'a' } }],
        'pause_turn',
      );
      const second = message(
        [{ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'b' } }],
        'pause_turn',
      );
      const { client, requests } = fake(first, second, recorded(ANSWER));

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect(requests).toHaveLength(3);
      expect(requests[2]!.messages).toEqual([
        requests[0]!.messages[0],
        { role: 'assistant', content: first.content },
        { role: 'assistant', content: second.content },
      ]);
    });

    it('gives up after three resumes', async () => {
      const { a, due } = await claimed();
      const paused = () => message([{ type: 'text', text: '...', citations: null }], 'pause_turn');
      const { client, requests } = fake(paused(), paused(), paused(), paused());

      expect(await estimateAssetValue(deps(client), due)).toBe('no_answer');
      expect(requests).toHaveLength(4);
      expect(await assetRow(a.id)).toMatchObject({ aiLastError: 'no_answer', aiRequestedAt: null });
    });

    it('records no_answer when the model never calls record_estimate', async () => {
      const { a, due } = await claimed();
      const { client } = fake(
        message([{ type: 'text', text: 'I cannot tell.', citations: null }], 'end_turn'),
      );

      expect(await estimateAssetValue(deps(client), due)).toBe('no_answer');
      expect(await valuationsOf(a.id)).toHaveLength(0);
      expect(await assetRow(a.id)).toMatchObject({ aiLastError: 'no_answer', aiRequestedAt: null });
    });

    it('records no_answer on a refusal', async () => {
      const { a, due } = await claimed();
      const { client } = fake(message([], 'refusal'));
      expect(await estimateAssetValue(deps(client), due)).toBe('no_answer');
      expect((await assetRow(a.id)).aiLastError).toBe('no_answer');
    });

    it('records no_answer when the answer breaks the rules', async () => {
      for (const bad of [
        { ...ANSWER, value: -1 },
        { ...ANSWER, value: 0, low: 0, high: 0 },
        { ...ANSWER, confidence: 'certain' },
        { ...ANSWER, sources: 'none' },
      ]) {
        const { a, due } = await claimed();
        const { client } = fake(recorded(bad));
        expect(await estimateAssetValue(deps(client), due)).toBe('no_answer');
        expect(await valuationsOf(a.id)).toHaveLength(0);
      }
    });

    /** Runs one answer through a fresh claimed asset and returns the stored ai valuation. */
    async function stored(answer: unknown, values: Partial<typeof asset.$inferInsert> = {}) {
      const { a, due } = await claimed(values);
      const { client } = fake(recorded(answer));
      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      const [v] = await valuationsOf(a.id);
      return v!;
    }

    it('clamps the range around the value; a missing end is the value', async () => {
      expect((await stored({ ...ANSWER, low: 400_000, high: 1 })).estimate).toMatchObject({
        low: 31_250_040,
        high: 31_250_040,
      });
      expect((await stored({ ...ANSWER, low: null, high: null })).estimate).toMatchObject({
        low: 31_250_040,
        high: 31_250_040,
      });
      expect((await stored({ ...ANSWER, low: -5, high: 0 })).estimate).toMatchObject({
        low: 0,
        high: 31_250_040,
      });
    });

    it('trims a long rationale to 400 characters on a word boundary', async () => {
      const words = 'comparable listing '.repeat(40); // 760 characters
      const { note } = await stored({ ...ANSWER, rationale: words });
      expect(note!.length).toBeLessThanOrEqual(400);
      expect(note!.length).toBeGreaterThan(300);
      expect(words.startsWith(note!.replace(/…$/, ''))).toBe(true);
      expect(note!.replace(/…$/, '')).toMatch(/(comparable|listing)$/);
    });

    it('keeps the first five usable sources and names an untitled one by its host', async () => {
      const url = (n: number) => `https://www.idealista.pt/imovel/${n}/`;
      const { estimate } = await stored({
        ...ANSWER,
        sources: [
          { title: 'bad', url: 'not a url' },
          { title: 'empty', url: '' },
          { title: 'script', url: 'javascript:alert(1)' },
          { title: '  ', url: url(1) },
          ...[2, 3, 4, 5, 6].map((n) => ({ title: ` T${n} `, url: url(n) })),
        ],
      });
      expect(estimate!.sources).toEqual([
        { title: 'www.idealista.pt', url: url(1) },
        { title: 'T2', url: url(2) },
        { title: 'T3', url: url(3) },
        { title: 'T4', url: url(4) },
        { title: 'T5', url: url(5) },
      ]);
    });

    it('drops sources outside the portals of the asset kind', async () => {
      const { estimate } = await stored({
        ...ANSWER,
        sources: [
          { title: 'portal', url: 'https://www.idealista.pt/imovel/1/' },
          { title: 'bare portal', url: 'https://supercasa.pt/x' },
          { title: 'elsewhere', url: 'https://example.com/x' },
          { title: 'lookalike', url: 'https://notidealista.pt/x' },
          { title: 'suffix trick', url: 'https://idealista.pt.evil.com/x' },
        ],
      });
      expect(estimate!.sources.map((s) => s.title)).toEqual(['portal', 'bare portal']);

      const art = await stored(
        { ...ANSWER, sources: [{ title: 'gallery', url: 'https://example.com/lot/1' }] },
        { kind: 'other', details: { category: 'art', description: 'Oil on canvas, 1960s' } },
      );
      expect(art.estimate!.sources).toEqual([
        { title: 'gallery', url: 'https://example.com/lot/1' },
      ]);
    });

    it('keeps a request made during the call, after an answer', async () => {
      const { a, due } = await claimed();
      const later = new Date(NOW.getTime() + 60_000);
      const { client } = fake(async () => {
        await t.owner.update(asset).set({ aiRequestedAt: later }).where(eq(asset.id, a.id));
        return recorded(ANSWER);
      });
      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect((await assetRow(a.id)).aiRequestedAt).toEqual(later);
    });

    it('keeps a request made during the call, after a failure', async () => {
      const { a, due } = await claimed();
      const later = new Date(NOW.getTime() + 60_000);
      const { client } = fake(async () => {
        await t.owner.update(asset).set({ aiRequestedAt: later }).where(eq(asset.id, a.id));
        throw Object.assign(new Error('overloaded'), { status: 529 });
      });
      expect(await estimateAssetValue(deps(client), due)).toBe('api_error');
      expect(await assetRow(a.id)).toMatchObject({
        aiRequestedAt: later,
        aiLastError: 'api_error',
      });
    });

    it('writes no value for an asset switched off during the call', async () => {
      const { a, due } = await claimed();
      const { client } = fake(async () => {
        await t.owner.update(asset).set({ aiValuation: false }).where(eq(asset.id, a.id));
        return recorded(ANSWER);
      });
      await estimateAssetValue(deps(client), due);
      expect(await valuationsOf(a.id)).toHaveLength(0);
    });

    it('skips the model when a value of another method exists for today', async () => {
      const { ctx, a, due } = await claimed();
      await addValuation(ctx, a.id, '2026-10-31', 12_345);
      const { client, requests } = fake(recorded(ANSWER));

      expect(await estimateAssetValue(deps(client), due)).toBe('ready');
      expect(requests).toHaveLength(0);
      expect(await valuationsOf(a.id)).toHaveLength(1);
      expect(await assetRow(a.id)).toMatchObject({ aiRequestedAt: null });
    });

    it('records insufficient_data when the model answers with a null value', async () => {
      const { a, due } = await claimed();
      const { client } = fake(
        recorded({
          ...ANSWER,
          value: null,
          low: null,
          high: null,
          confidence: 'low',
          sources: [],
          reason: 'No comparable listings',
        }),
      );

      expect(await estimateAssetValue(deps(client), due)).toBe('insufficient_data');
      expect(await valuationsOf(a.id)).toHaveLength(0);
      expect(await assetRow(a.id)).toMatchObject({
        aiLastError: 'insufficient_data',
        aiRequestedAt: null,
      });
    });

    it('records insufficient_data without calling the model when details are missing', async () => {
      const { a, due } = await claimed({ details: { propertyType: 'apartment' } });
      const { client, requests } = fake();

      expect(await estimateAssetValue(deps(client), due)).toBe('insufficient_data');
      expect(requests).toHaveLength(0);
      expect((await assetRow(a.id)).aiLastError).toBe('insufficient_data');
    });

    it('records api_error when the provider call fails, without logging the message', async () => {
      const { a, due } = await claimed();
      const { client } = fake(Object.assign(new Error('secret provider text'), { status: 529 }));
      logs.length = 0;

      expect(await estimateAssetValue(deps(client), due)).toBe('api_error');
      expect(await assetRow(a.id)).toMatchObject({ aiLastError: 'api_error', aiRequestedAt: null });
      expect(logs.join('\n')).not.toMatch(/secret provider text/);
    });

    it('never logs the details or the rationale', async () => {
      const { due } = await claimed();
      const { client } = fake(recorded(ANSWER));
      logs.length = 0;
      await estimateAssetValue(deps(client), due);
      expect(logs.length).toBeGreaterThan(0);
      const text = logs.join('\n');
      expect(text).not.toMatch(/Lisboa|Comparable|idealista/);
    });
  });

  it('marks a claimed asset failed, keeping a request newer than the claim', async () => {
    const ctx = await household();
    const a = await addAsset(ctx, { aiRequestedAt: NOW });
    const b = await addAsset(ctx, { aiRequestedAt: NOW });
    const due = await claimDueAssetValuations(t.db, { now: NOW, limit: 1_000, tz: 'UTC' });
    const dueA = due.find((d) => d.assetId === a.id)!;
    const dueB = due.find((d) => d.assetId === b.id)!;
    const later = new Date(NOW.getTime() + 60_000);
    await t.owner.update(asset).set({ aiRequestedAt: later }).where(eq(asset.id, b.id));

    await markAssetValuationFailed(t.db, dueA, 'api_error');
    await markAssetValuationFailed(t.db, dueB, 'api_error');
    expect(await assetRow(a.id)).toMatchObject({ aiLastError: 'api_error', aiRequestedAt: null });
    expect(await assetRow(b.id)).toMatchObject({ aiLastError: 'api_error', aiRequestedAt: later });
  });

  it('only touches the claimed household asset', async () => {
    const ctx = await household();
    const a = await addAsset(ctx, { aiRequestedAt: NOW });
    const other = await addAsset(ctx, { aiRequestedAt: NOW });
    const due = (await claim(a.id))!;
    const { client } = fake(recorded(ANSWER));
    await estimateAssetValue(deps(client), due);
    const [row] = await t.owner
      .select()
      .from(asset)
      .where(and(eq(asset.id, other.id), eq(asset.householdId, ctx.householdId)));
    expect(row!.aiRequestedAt).toEqual(NOW);
    expect(await valuationsOf(other.id)).toHaveLength(0);
  });
});
