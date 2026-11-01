import { describe, expect, it } from 'vitest';
import { createTrading212Client } from '../../src/trading212/client.js';
import {
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../../src/types.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(fetchFn: typeof fetch, extra: { maxRetries?: number } = {}) {
  return createTrading212Client({
    apiKey: 'key-1',
    apiSecret: 'secret-1',
    baseUrl: 'https://t212.test/api/v0',
    fetch: fetchFn,
    sleep: async () => {},
    now: () => 1_700_000_000_000,
    ...extra,
  });
}

const authorization = `Basic ${Buffer.from('key-1:secret-1').toString('base64')}`;

describe('Trading 212 history export client', () => {
  it('requests a transactions-only export and returns the report id', async () => {
    const { fn, calls } = fakeFetch(() => json({ reportId: 42 }));
    const id = await client(fn).requestHistoryExport({
      timeFrom: '2026-01-01T00:00:00.000Z',
      timeTo: '2026-10-29T00:00:00.000Z',
    });
    expect(id).toBe(42);
    expect(calls[0]?.url).toBe('https://t212.test/api/v0/history/exports');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      dataIncluded: {
        includeOrders: false,
        includeDividends: false,
        includeTransactions: true,
        includeInterest: false,
      },
      timeFrom: '2026-01-01T00:00:00.000Z',
      timeTo: '2026-10-29T00:00:00.000Z',
    });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(authorization);
  });

  it('rejects an export response without a numeric reportId', async () => {
    const { fn } = fakeFetch(() => json({ reportId: 'x' }));
    await expect(
      client(fn).requestHistoryExport({ timeFrom: 'a', timeTo: 'b' }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('surfaces a 429 as a rate-limit error', async () => {
    const { fn } = fakeFetch(() => json({}, 429, { 'retry-after': '45' }));
    await expect(
      client(fn, { maxRetries: 0 }).requestHistoryExport({ timeFrom: 'a', timeTo: 'b' }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('lists exports keeping reportId, status and downloadLink', async () => {
    const { fn, calls } = fakeFetch(() =>
      json([
        { reportId: 1, status: 'Finished', downloadLink: 'https://s3.test/a.csv', extra: 1 },
        { reportId: 2, status: 'Running', downloadLink: null },
      ]),
    );
    expect(await client(fn).listHistoryExports()).toEqual([
      { reportId: 1, status: 'Finished', downloadLink: 'https://s3.test/a.csv' },
      { reportId: 2, status: 'Running' },
    ]);
    expect(calls[0]?.url).toBe('https://t212.test/api/v0/history/exports');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('downloads the CSV without the Authorization header', async () => {
    const { fn, calls } = fakeFetch(() => new Response('Action,ID\nx,y\n'));
    const text = await client(fn).downloadHistoryExport('https://s3.test/a.csv?sig=1');
    expect(text).toBe('Action,ID\nx,y\n');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  it('refuses a non-https download link without fetching', async () => {
    const { fn, calls } = fakeFetch(() => new Response(''));
    await expect(client(fn).downloadHistoryExport('http://s3.test/a.csv')).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a download that was redirected to http', async () => {
    const { fn } = fakeFetch(() => {
      const res = new Response('ID\nref-1\n');
      Object.defineProperty(res, 'redirected', { value: true });
      Object.defineProperty(res, 'url', { value: 'http://s3.test/a.csv' });
      return res;
    });
    await expect(client(fn).downloadHistoryExport('https://s3.test/a.csv')).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('refuses a download larger than the cap', async () => {
    const { fn } = fakeFetch(() => new Response('x'.repeat(2_000)));
    await expect(
      createTrading212Client({
        apiKey: 'k',
        apiSecret: 's',
        baseUrl: 'https://t212.test/api/v0',
        fetch: fn,
        maxExportBytes: 1_000,
      }).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('rejects early on an oversized Content-Length without reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(10));
        },
      },
      { highWaterMark: 0 },
    );
    const { fn } = fakeFetch(() => new Response(body, { headers: { 'content-length': '5000' } }));
    await expect(
      createTrading212Client({
        apiKey: 'k',
        apiSecret: 's',
        baseUrl: 'https://t212.test/api/v0',
        fetch: fn,
        maxExportBytes: 1_000,
      }).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toThrow('too large');
    expect(pulled).toBe(false);
  });

  it('stops reading a stream that passes the cap and cancels it', async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fn } = fakeFetch(() => new Response(body));
    await expect(
      createTrading212Client({
        apiKey: 'k',
        apiSecret: 's',
        baseUrl: 'https://t212.test/api/v0',
        fetch: fn,
        maxExportBytes: 1_000,
      }).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toThrow('too large');
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(10);
  });

  it('maps download failures to provider errors', async () => {
    const unavailable = fakeFetch(() => new Response('', { status: 503 }));
    await expect(
      client(unavailable.fn).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const rejected = fakeFetch(() => new Response('', { status: 403 }));
    await expect(
      client(rejected.fn).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    const down = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    await expect(
      client(down).downloadHistoryExport('https://s3.test/a.csv'),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
