import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendMessage, listMessages, type ServiceCtx } from '@arfolio/services';
import type { AdvisorModelClient } from '@arfolio/mcp';
import { startAdvisorTestDb, type AdvisorTestDb } from '@/advisor-test-utils';
import { integrationConfigFixture } from '@/test-utils';

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  session: null as unknown,
  cfg: undefined as unknown,
  client: undefined as unknown,
  created: [] as string[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/brand', () => ({ getBrand: () => ({ name: 'Testbrand' }) }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    ADVISOR_LEARNING_MONTHS: 3,
    ADVISOR_WEEKLY_CAP: 2,
    ADVISOR_DAILY_MESSAGES: 2,
    ADVISOR_MAX_TOOL_CALLS: 8,
    APP_URL: 'https://app.example.test',
  }),
}));
vi.mock('@/server/session', () => ({ getSessionContext: async () => state.session }));
vi.mock('@/server/integration-config', () => ({ getIntegrationConfig: async () => state.cfg }));
vi.mock('@/server/advisor-client', () => ({
  createClient: (apiKey: string) => {
    state.created.push(apiKey);
    return state.client;
  },
}));

import { POST } from './route';

type Call = Parameters<AdvisorModelClient['stream']>;

describe('POST /api/advisor/messages', () => {
  let t: AdvisorTestDb;
  let hh: string;
  let calls: Call[];

  const fakeClient = (answer = 'Hello there'): AdvisorModelClient => ({
    async stream(params, onText, signal) {
      calls.push([params, onText, signal]);
      onText(answer);
      return {
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
      } as never;
    },
  });

  const signIn = (ctx: ServiceCtx) => {
    state.session = {
      householdId: ctx.householdId,
      role: ctx.role,
      user: { id: ctx.userId },
    };
  };
  const post = (
    body: unknown,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) =>
    POST(
      new Request('http://localhost/api/advisor/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          ...init.headers,
        },
        body: JSON.stringify(body),
        ...(init.signal ? { signal: init.signal } : {}),
      }) as never,
    );

  beforeAll(async () => {
    t = await startAdvisorTestDb();
    state.db = t.db;
    hh = await t.household();
  });
  afterAll(() => t.close());
  beforeEach(() => {
    calls = [];
    state.created = [];
    state.session = null;
    state.cfg = integrationConfigFixture({ anthropicApiKey: 'sk-ant-e2e-fake-key-1' });
    state.client = fakeClient();
  });

  describe('request origin', () => {
    const ok = async (headers: Record<string, string>, remove: string[] = []) => {
      signIn(await t.member(hh));
      const all = { 'content-type': 'application/json', ...headers };
      for (const name of remove) delete all[name];
      const res = await POST(
        new Request('http://localhost/api/advisor/messages', {
          method: 'POST',
          headers: all,
          body: JSON.stringify({ text: 'hi' }),
        }) as never,
      );
      await res.text();
      return res.status;
    };

    it('answers 415 unless the body is JSON, before anything is stored or called', async () => {
      const ctx = await t.member(hh);
      signIn(ctx);
      for (const type of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        const res = await post({ text: 'hi' }, { headers: { 'content-type': type } });
        expect(res.status).toBe(415);
      }
      expect(calls).toHaveLength(0);
      expect(await listMessages(ctx, {})).toEqual([]);
    });

    it('accepts JSON with a charset', async () => {
      signIn(await t.member(hh));
      const res = await post(
        { text: 'hi' },
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
      expect(res.status).toBe(200);
      await res.text();
    });

    it.each(['cross-site', 'same-site', 'none'])(
      'answers 403 for Sec-Fetch-Site %s',
      async (site) => {
        const ctx = await t.member(hh);
        signIn(ctx);
        const res = await post({ text: 'hi' }, { headers: { 'sec-fetch-site': site } });
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0);
        expect(await listMessages(ctx, {})).toEqual([]);
      },
    );

    it('without Sec-Fetch-Site, accepts only the configured origin', async () => {
      expect(await ok({ origin: 'https://app.example.test' }, ['sec-fetch-site'])).toBe(200);
      expect(await ok({ origin: 'https://evil.example' }, ['sec-fetch-site'])).toBe(403);
      expect(await ok({}, ['sec-fetch-site'])).toBe(403);
    });
  });

  it('answers 401 without a signed-in member', async () => {
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('answers 403 ai_off when the household switched AI off, without calling the model', async () => {
    const off = await t.member(await t.household({ aiEnabled: false }));
    signIn(off);
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'ai_off' });
    expect(calls).toHaveLength(0);
    expect(state.created).toEqual([]);
    expect(await listMessages(off, {})).toEqual([]);
  });

  it('answers 403 ai_off when no API key is configured', async () => {
    state.cfg = integrationConfigFixture();
    signIn(await t.member(hh));
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it.each([[{}], [{ text: '' }], [{ text: 'x'.repeat(4001) }], [{ text: 5 }]])(
    'answers 400 for the invalid body %#',
    async (body) => {
      signIn(await t.member(hh));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    },
  );

  it("answers 429 daily_limit once the member sent the day's messages", async () => {
    const ctx = await t.member(hh);
    signIn(ctx);
    for (const text of ['one', 'two']) {
      await appendMessage(ctx, { role: 'user', origin: 'chat', text });
    }
    const res = await post({ text: 'three' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'daily_limit' });
    expect(calls).toHaveLength(0);
  });

  it('lets only one of two concurrent posts through at limit - 1', async () => {
    const ctx = await t.member(hh);
    signIn(ctx);
    await appendMessage(ctx, { role: 'user', origin: 'chat', text: 'one' });
    const [r1, r2] = await Promise.all([post({ text: 'two' }), post({ text: 'three' })]);
    const bodies = await Promise.all([r1.text(), r2.text()]);
    expect([r1.status, r2.status].sort()).toEqual([200, 429]);
    expect(bodies.filter((b) => b.includes('event: done'))).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const users = (await listMessages(ctx, {})).filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
  });

  it("answers 409 busy while the member's previous answer is still pending", async () => {
    const ctx = await t.member(hh);
    signIn(ctx);
    await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: '', status: 'pending' });
    const res = await post({ text: 'again' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'busy' });
    expect(calls).toHaveLength(0);
    expect(await listMessages(ctx, {})).toHaveLength(1);
  });

  it('streams text then done as server-sent events and stores the answer', async () => {
    const ctx = await t.member(hh, 'viewer');
    signIn(ctx);
    const res = await post({ text: 'How is this month?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body.indexOf('event: text')).toBeGreaterThanOrEqual(0);
    expect(body).toContain('data: {"delta":"Hello there"}');
    expect(body.indexOf('event: done')).toBeGreaterThan(body.indexOf('event: text'));
    const stored = await listMessages(ctx, {});
    const answer = stored.find((m) => m.role === 'assistant')!;
    expect(body).toContain(`data: {"messageId":"${answer.id}"}`);
    expect(answer).toMatchObject({ text: 'Hello there', status: 'complete' });
    expect(state.created).toEqual(['sk-ant-e2e-fake-key-1']);
    expect(calls[0]![0].model).toBe('claude-opus-5-5');
  });

  it("never shows another member's messages to the model", async () => {
    const a = await t.member(hh);
    const b = await t.member(hh);
    await appendMessage(a, { role: 'user', origin: 'chat', text: 'SECRET-FROM-A' });
    await appendMessage(a, { role: 'assistant', origin: 'chat', text: 'REPLY-TO-A' });
    signIn(b);
    const res = await post({ text: 'my own question' });
    await res.text();
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]![0].messages);
    expect(sent).toContain('my own question');
    expect(sent).not.toContain('SECRET-FROM-A');
    expect(sent).not.toContain('REPLY-TO-A');
  });

  it('sends an error event with a generic code when the model call fails', async () => {
    state.client = {
      async stream() {
        throw new Error('provider said: 401 for account 12345');
      },
    } satisfies AdvisorModelClient;
    const ctx = await t.member(hh);
    signIn(ctx);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await (await post({ text: 'secret question' })).text();
    expect(body).toContain('event: error');
    expect(body).toContain('data: {"code":"unavailable"}');
    expect(body).not.toContain('event: done');
    expect(body).not.toContain('12345');
    const logged = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(logged).not.toContain('12345');
    expect(logged).not.toContain('secret question');
  });

  it('aborts the model call when the client disconnects', async () => {
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    state.client = {
      stream(_params, _onText, signal) {
        seen = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          abort.abort();
        });
      },
    } satisfies AdvisorModelClient;
    signIn(await t.member(hh));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post({ text: 'hi' }, { signal: abort.signal });
    await res.text();
    spy.mockRestore();
    expect(seen?.aborted).toBe(true);
  });
});
