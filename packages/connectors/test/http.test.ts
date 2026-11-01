import { afterEach, describe, expect, it } from 'vitest';
import { createHttp } from '../src/http.js';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../src/types.js';
import { sendJson, startFakeServer, type FakeServer } from './fakes/server.js';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function http(overrides: Partial<Parameters<typeof createHttp>[0]> = {}) {
  const sleeps: number[] = [];
  const client = createHttp({
    label: 'Fake',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { client, sleeps };
}

describe('createHttp.request', () => {
  it('returns parsed JSON and sends the given headers and body', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { ok: true }));
    const { client } = http();
    const out = await client.request({
      method: 'POST',
      url: `${server.baseUrl}/x`,
      headers: { authorization: 'Bearer abc' },
      body: { a: 1 },
    });
    expect(out.json).toEqual({ ok: true });
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/x',
      body: '{"a":1}',
    });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer abc');
    expect(server.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it.each([401, 403])('maps %i to ProviderAuthError', async (status) => {
    server = await startFakeServer((_req, res) => sendJson(res, { message: 'nope' }, status));
    await expect(
      http().client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps 429 with Retry-After to ProviderRateLimitError carrying the seconds (no retries)', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 429, { 'retry-after': '7' }));
    const { client, sleeps } = http({ maxRetries: 0 });
    const err = await client
      .request({ method: 'GET', url: `${server.baseUrl}/x` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterSeconds).toBe(7);
    expect(sleeps).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('backs off honouring Retry-After and succeeds on a later attempt', async () => {
    server = await startFakeServer((_req, res, i) =>
      i < 2 ? sendJson(res, {}, 429, { 'retry-after': '2' }) : sendJson(res, { done: 1 }),
    );
    const { client, sleeps } = http({ maxRetries: 3 });
    const out = await client.request({ method: 'GET', url: `${server.baseUrl}/x` });
    expect(out.json).toEqual({ done: 1 });
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('gives up after maxRetries and throws ProviderRateLimitError', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 429, { 'retry-after': '1' }));
    const { client, sleeps } = http({ maxRetries: 3 });
    await expect(
      client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(server.requests).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
  });

  it('does not wait when Retry-After exceeds the 60 s cap', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 429, { 'retry-after': '120' }));
    const { client, sleeps } = http({ maxRetries: 3 });
    const err = await client
      .request({ method: 'GET', url: `${server.baseUrl}/x` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterSeconds).toBe(120);
    expect(sleeps).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('falls back to x-ratelimit-reset (unix seconds) when Retry-After is absent', async () => {
    server = await startFakeServer((_req, res, i) =>
      i === 0 ? sendJson(res, {}, 429, { 'x-ratelimit-reset': '1700000005' }) : sendJson(res, {}),
    );
    const { client, sleeps } = http({ maxRetries: 1 });
    await client.request({ method: 'GET', url: `${server.baseUrl}/x` });
    expect(sleeps).toEqual([5000]);
  });

  it('treats an empty Retry-After as absent', async () => {
    server = await startFakeServer((_req, res, i) =>
      i === 0 ? sendJson(res, {}, 429, { 'retry-after': '' }) : sendJson(res, {}),
    );
    const { client, sleeps } = http({ maxRetries: 1 });
    await client.request({ method: 'GET', url: `${server.baseUrl}/x` });
    expect(sleeps).toEqual([1000]); // exponential default, not 0
  });

  it('maps an interrupted body read to ProviderUnavailableError, not a response error', async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"a":');
      setTimeout(() => res.destroy(), 20);
    });
    await expect(
      http().client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps 5xx to ProviderUnavailableError', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 503));
    await expect(
      http().client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps a network failure to ProviderUnavailableError', async () => {
    const dead = await startFakeServer((_req, res) => res.end());
    const url = `${dead.baseUrl}/x`;
    await dead.close();
    await expect(http().client.request({ method: 'GET', url })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it('maps malformed JSON to ProviderResponseError', async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    });
    await expect(
      http().client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('maps other 4xx to ProviderResponseError', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 400));
    await expect(
      http().client.request({ method: 'GET', url: `${server.baseUrl}/x` }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('skips body parsing when expectJson is false', async () => {
    server = await startFakeServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const out = await http().client.request({
      method: 'DELETE',
      url: `${server.baseUrl}/x`,
      expectJson: false,
    });
    expect(out.json).toBeUndefined();
  });

  it('never leaks response bodies, headers or URLs into error messages', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { detail: 'LEAKEDBODY' }, 400));
    const err = await http()
      .client.request({
        method: 'GET',
        url: `${server.baseUrl}/sessions/SESSIONSECRET`,
        headers: { authorization: 'Bearer TOKENSECRET' },
      })
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('400');
    for (const secret of ['LEAKEDBODY', 'SESSIONSECRET', 'TOKENSECRET', '127.0.0.1']) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});
