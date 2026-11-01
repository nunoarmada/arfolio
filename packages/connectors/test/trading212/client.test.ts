import { afterEach, describe, expect, it } from 'vitest';
import { createTrading212Client } from '../../src/trading212/client.js';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
} from '../../src/types.js';
import { sendJson, startFakeServer, type FakeServer } from '../fakes/server.js';

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(
  baseUrl: string,
  extra: Partial<Parameters<typeof createTrading212Client>[0]> = {},
  sleeps: number[] = [],
) {
  return createTrading212Client({
    apiKey: 'key-1',
    apiSecret: 'secret-1',
    baseUrl: `${baseUrl}/api/v0`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    ...extra,
  });
}

const txItem = (reference: string, dateTime: string) => ({
  reference,
  type: 'DEPOSIT',
  amount: 10,
  currency: 'EUR',
  dateTime,
});

describe('Trading 212 client', () => {
  it('authenticates with Basic base64(key:secret)', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { items: [], nextPagePath: null }));
    await client(server.baseUrl).listTransactions({});
    expect(server.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('key-1:secret-1').toString('base64')}`,
    );
  });

  it('reads the account summary and positions from the current endpoints', async () => {
    server = await startFakeServer((req, res) => {
      if (req.path === '/api/v0/equity/account/summary') {
        sendJson(res, {
          id: 7,
          currency: 'EUR',
          totalValue: 100,
          cash: { availableToTrade: 10, inPies: 0, reservedForOrders: 0 },
          investments: { currentValue: 90 },
        });
      } else {
        sendJson(res, [
          {
            instrument: { ticker: 'ABCD_US_EQ', name: 'Example', currency: 'USD' },
            quantity: 2,
            averagePricePaid: 1,
            currentPrice: 2,
            walletImpact: {
              currency: 'EUR',
              totalCost: 2,
              currentValue: 4,
              unrealizedProfitLoss: 2,
            },
          },
        ]);
      }
    });
    const c = client(server.baseUrl);
    expect((await c.getAccountSummary()).totalValue).toBe(10000);
    const positions = await c.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ ticker: 'ABCD_US_EQ', quantity: '2', value: 400 });
    expect(server.requests.map((r) => r.path)).toEqual([
      '/api/v0/equity/account/summary',
      '/api/v0/equity/positions',
    ]);
  });

  it('follows nextPagePath, whether or not it carries the /api/v0 prefix', async () => {
    server = await startFakeServer((_req, res, i) => {
      if (i === 0) {
        sendJson(res, {
          items: [txItem('A', '2026-03-01T10:00:00Z')],
          nextPagePath: '/api/v0/equity/history/transactions?limit=50&cursor=c1&time=t1',
        });
      } else if (i === 1) {
        sendJson(res, {
          items: [txItem('B', '2026-02-01T10:00:00Z')],
          nextPagePath: '/equity/history/transactions?limit=50&cursor=c2&time=t2',
        });
      } else {
        sendJson(res, { items: [txItem('C', '2026-01-01T10:00:00Z')], nextPagePath: null });
      }
    });
    const out = await client(server.baseUrl).listTransactions({});
    expect(out.incomplete).toBe(false);
    expect(out.items.map((t) => t.externalId)).toEqual(['tx:A', 'tx:B', 'tx:C']);
    expect(server.requests.map((r) => r.path)).toEqual([
      '/api/v0/equity/history/transactions?limit=50',
      '/api/v0/equity/history/transactions?limit=50&cursor=c1&time=t1',
      '/api/v0/equity/history/transactions?limit=50&cursor=c2&time=t2',
    ]);
  });

  it('filters transactions and dividends client-side by `since`', async () => {
    server = await startFakeServer((req, res) => {
      if (req.path.includes('dividends')) {
        sendJson(res, {
          items: [
            { reference: 'D1', amount: 1, currency: 'EUR', paidOn: '2026-03-01T00:00:00Z' },
            { reference: 'D2', amount: 1, currency: 'EUR', paidOn: '2026-01-01T00:00:00Z' },
          ],
          nextPagePath: null,
        });
      } else {
        sendJson(res, {
          items: [txItem('A', '2026-03-01T10:00:00Z'), txItem('B', '2026-01-01T10:00:00Z')],
          nextPagePath: null,
        });
      }
    });
    const c = client(server.baseUrl);
    expect(
      (await c.listTransactions({ since: '2026-02-01' })).items.map((t) => t.externalId),
    ).toEqual(['tx:A']);
    const divs = await c.listDividends({ since: '2026-02-01' });
    expect(divs.items.map((t) => t.externalId)).toEqual(['div:D1']);
    expect(server.requests[1]?.path).toBe('/api/v0/equity/history/dividends?limit=50');
  });

  describe('early stop on long histories', () => {
    // Newest first, 50 per page in reality; three items per page here. Page 2 reaches 2026-01.
    const pages: Record<string, string[]> = {
      p1: ['2026-03-20', '2026-03-10', '2026-03-01'],
      p2: ['2026-02-20', '2026-02-05', '2026-01-15'],
      p3: ['2026-01-10', '2026-01-05', '2025-12-30'],
      p4: ['2025-12-20', '2025-12-10', '2025-12-01'],
    };
    const next: Record<string, string | null> = { p1: 'p2', p2: 'p3', p3: 'p4', p4: null };

    const handler = (kind: 'transactions' | 'dividends') => (req: { path: string }) => {
      const key = new URL(req.path, 'http://x').searchParams.get('cursor') ?? 'p1';
      const dates = pages[key] ?? [];
      return {
        items: dates.map((d, i) =>
          kind === 'transactions'
            ? txItem(`${key}-${i}`, `${d}T10:00:00Z`)
            : { reference: `${key}-${i}`, amount: 1, currency: 'EUR', paidOn: `${d}T00:00:00Z` },
        ),
        nextPagePath: next[key] ? `/equity/history/${kind}?limit=50&cursor=${next[key]}` : null,
      };
    };

    it('stops transactions after the first page whose oldest item is older than `since`', async () => {
      server = await startFakeServer((req, res) => sendJson(res, handler('transactions')(req)));
      const out = await client(server.baseUrl).listTransactions({ since: '2026-02-01' });
      expect(server.requests).toHaveLength(2);
      expect(out.incomplete).toBe(false);
      expect(out.items.map((t) => t.bookingDate)).toEqual([
        '2026-03-20',
        '2026-03-10',
        '2026-03-01',
        '2026-02-20',
        '2026-02-05',
      ]);
    });

    it('reads one extra page of margin for dividends, which are not strictly chronological', async () => {
      server = await startFakeServer((req, res) => sendJson(res, handler('dividends')(req)));
      const out = await client(server.baseUrl).listDividends({ since: '2026-02-01' });
      expect(server.requests).toHaveLength(3);
      expect(out.incomplete).toBe(false);
      expect(out.items).toHaveLength(5);
    });

    it('walks everything when no `since` is given', async () => {
      server = await startFakeServer((req, res) => sendJson(res, handler('transactions')(req)));
      const out = await client(server.baseUrl).listTransactions({});
      expect(server.requests).toHaveLength(4);
      expect(out.items).toHaveLength(12);
    });

    it('does not stop while the oldest item of a page is still within the window', async () => {
      server = await startFakeServer((req, res) => sendJson(res, handler('transactions')(req)));
      const out = await client(server.baseUrl).listTransactions({ since: '2026-01-01' });
      expect(server.requests).toHaveLength(3);
      expect(out.items).toHaveLength(8);
    });
  });

  it('refuses an absolute nextPagePath so credentials never leave the configured host', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { items: [], nextPagePath: 'https://evil.example/steal' }),
    );
    await expect(client(server.baseUrl).listTransactions({})).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
    expect(server.requests).toHaveLength(1);
  });

  it('throws ProviderResponseError when the page guard is exceeded or a path repeats', async () => {
    server = await startFakeServer((_req, res, i) =>
      sendJson(res, { items: [], nextPagePath: `/equity/history/transactions?cursor=${i}` }),
    );
    await expect(
      client(server.baseUrl, { maxPages: 3 }).listTransactions({}),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(server.requests).toHaveLength(3);
    await server.close();

    server = await startFakeServer((_req, res) =>
      sendJson(res, { items: [], nextPagePath: '/equity/history/transactions?cursor=same' }),
    );
    await expect(client(server.baseUrl).listTransactions({})).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('keeps earlier pages and flags incomplete when a later page 404s', async () => {
    server = await startFakeServer((_req, res, i) =>
      i === 0
        ? sendJson(res, {
            items: [txItem('A', '2026-03-01T10:00:00Z')],
            nextPagePath: '/equity/history/transactions?cursor=c1',
          })
        : sendJson(res, { title: 'not found' }, 404),
    );
    const out = await client(server.baseUrl).listTransactions({});
    expect(out.incomplete).toBe(true);
    expect(out.items.map((t) => t.externalId)).toEqual(['tx:A']);
  });

  it('still fails when the first page 404s', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 404));
    await expect(client(server.baseUrl).listTransactions({})).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('maps 401 and 403 to ProviderAuthError', async () => {
    for (const status of [401, 403]) {
      server = await startFakeServer((_req, res) => sendJson(res, {}, status));
      await expect(client(server.baseUrl).getAccountSummary()).rejects.toBeInstanceOf(
        ProviderAuthError,
      );
      await server.close();
    }
    server = undefined;
  });

  it('backs off on 429 honouring Retry-After, then succeeds', async () => {
    server = await startFakeServer((_req, res, i) =>
      i === 0
        ? sendJson(res, {}, 429, { 'retry-after': '3' })
        : sendJson(res, { items: [], nextPagePath: null }),
    );
    const sleeps: number[] = [];
    await client(server.baseUrl, {}, sleeps).listTransactions({});
    expect(sleeps).toEqual([3000]);
    expect(server.requests).toHaveLength(2);
  });

  it('throws ProviderRateLimitError once retries are exhausted', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 429, { 'retry-after': '1' }));
    const sleeps: number[] = [];
    const err = await client(server.baseUrl, {}, sleeps)
      .listDividends({})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterSeconds).toBe(1);
    expect(server.requests).toHaveLength(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it('maps malformed JSON and unexpected shapes to ProviderResponseError', async () => {
    server = await startFakeServer((req, res) => {
      if (req.path.includes('summary')) {
        res.writeHead(200);
        res.end('oops');
      } else {
        sendJson(res, { nope: true });
      }
    });
    const c = client(server.baseUrl);
    await expect(c.getAccountSummary()).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(c.listTransactions({})).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(c.getPositions()).rejects.toBeInstanceOf(ProviderResponseError);
  });

  describe('pies', () => {
    it('lists pies as minor units of the given currency', async () => {
      const paths: string[] = [];
      server = await startFakeServer((req, res) => {
        paths.push(req.path);
        sendJson(res, [
          {
            id: 123,
            cash: 0,
            progress: 0.5,
            status: 'AHEAD',
            result: { priceAvgInvestedValue: 450.5, priceAvgValue: 470.1, priceAvgResult: 19.6 },
          },
          { id: 7, result: { priceAvgInvestedValue: 0, priceAvgValue: 0 } },
        ]);
      });
      const pies = await client(server.baseUrl).listPies('EUR');
      expect(pies).toEqual([
        { id: '123', invested: 45050, value: 47010 },
        { id: '7', invested: 0, value: 0 },
      ]);
      expect(paths).toEqual(['/api/v0/equity/pies']);
    });

    it('rejects a malformed pies payload', async () => {
      for (const body of [
        { nope: true },
        [{ id: 'x', result: { priceAvgInvestedValue: 1, priceAvgValue: 1 } }],
        [{ id: 1, result: { priceAvgInvestedValue: 'a', priceAvgValue: 1 } }],
      ]) {
        server = await startFakeServer((_req, res) => sendJson(res, body));
        await expect(client(server.baseUrl).listPies('EUR')).rejects.toBeInstanceOf(
          ProviderResponseError,
        );
        await server.close();
        server = undefined;
      }
    });

    it('treats an absent or null pie result and null values as zero', async () => {
      server = await startFakeServer((_req, res) =>
        sendJson(res, [
          { id: 1 },
          { id: 2, result: null },
          { id: 3, result: { priceAvgInvestedValue: null, priceAvgValue: null } },
        ]),
      );
      expect(await client(server.baseUrl).listPies('EUR')).toEqual([
        { id: '1', invested: 0, value: 0 },
        { id: '2', invested: 0, value: 0 },
        { id: '3', invested: 0, value: 0 },
      ]);
    });

    it('maps a missing pies:read scope (403) to ProviderAuthError', async () => {
      server = await startFakeServer((_req, res) => sendJson(res, {}, 403));
      await expect(client(server.baseUrl).listPies('EUR')).rejects.toBeInstanceOf(
        ProviderAuthError,
      );
    });

    it('reads the pie name from its settings', async () => {
      const paths: string[] = [];
      server = await startFakeServer((req, res) => {
        paths.push(req.path);
        sendJson(res, { instruments: [], settings: { id: 123, name: 'Reforma', goal: 1000 } });
      });
      expect(await client(server.baseUrl).getPieName('123')).toBe('Reforma');
      expect(paths).toEqual(['/api/v0/equity/pies/123']);
    });

    it('rejects a pie detail without a name or with an unsafe id', async () => {
      server = await startFakeServer((_req, res) => sendJson(res, { settings: {} }));
      const c = client(server.baseUrl);
      await expect(c.getPieName('123')).rejects.toBeInstanceOf(ProviderResponseError);
      await expect(c.getPieName('../x')).rejects.toBeInstanceOf(ProviderResponseError);
    });
  });

  it('never puts the key or secret into error messages', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 401));
    const err = (await client(server.baseUrl)
      .getAccountSummary()
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('key-1');
    expect(err.message).not.toContain('secret-1');
    expect(err.message).not.toContain(Buffer.from('key-1:secret-1').toString('base64'));
  });
});
