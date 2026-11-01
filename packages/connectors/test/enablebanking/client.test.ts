import { createPublicKey, verify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnableBankingClient } from '../../src/enablebanking/client.js';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../../src/types.js';
import { generateTestKeyPair } from '../fakes/keys.js';
import { sendJson, startFakeServer, type FakeServer } from '../fakes/server.js';

const keys = generateTestKeyPair();
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(
  baseUrl: string,
  extra: Partial<Parameters<typeof createEnableBankingClient>[0]> = {},
) {
  return createEnableBankingClient({
    appId: 'app-1',
    privateKeyPem: keys.privateKeyPem,
    baseUrl,
    sleep: async () => {},
    ...extra,
  });
}

const tx = (id: string, extra: Record<string, unknown> = {}) => ({
  transaction_id: id,
  status: 'BOOK',
  credit_debit_indicator: 'DBIT',
  transaction_amount: { amount: '1.00', currency: 'EUR' },
  booking_date: '2026-03-01',
  remittance_information: [`tx ${id}`],
  ...extra,
});

describe('Enable Banking client', () => {
  it('sends a Bearer JWT verifiable with the public key on every call', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { aspsps: [] }));
    await client(server.baseUrl).listAspsps('PT');
    const auth = server.requests[0]?.headers.authorization ?? '';
    expect(auth).toMatch(/^Bearer /);
    const [h, p, s] = auth.slice(7).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'RS256',
      kid: 'app-1',
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        createPublicKey(keys.publicKeyPem),
        Buffer.from(s, 'base64url'),
      ),
    ).toBe(true);
  });

  it('lists ASPSPs for a country', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        aspsps: [
          {
            name: 'Mock Bank',
            country: 'PT',
            maximum_consent_validity: 7_776_000,
            required_psu_headers: ['psu-ip-address'],
            psu_types: ['personal'],
            logo: 'https://logos.example/mock.png',
            beta: true,
          },
          { name: 'Plain Bank', country: 'PT', logo: 42, beta: 'yes' },
        ],
      }),
    );
    const out = await client(server.baseUrl).listAspsps('PT');
    expect(server.requests[0]?.path).toBe('/aspsps?country=PT');
    expect(out).toEqual([
      {
        name: 'Mock Bank',
        country: 'PT',
        maximumConsentValiditySeconds: 7_776_000,
        requiredPsuHeaders: ['psu-ip-address'],
        psuTypes: ['personal'],
        logo: 'https://logos.example/mock.png',
        beta: true,
      },
      { name: 'Plain Bank', country: 'PT', requiredPsuHeaders: [], psuTypes: [] },
    ]);
  });

  it('starts auth with the documented body and returns the redirect url', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { url: 'https://bank.example/auth?x=1', authorization_id: 'auth-1' }),
    );
    const out = await client(server.baseUrl).startAuth({
      aspsp: { name: 'Mock Bank', country: 'PT' },
      state: 'state-123',
      redirectUrl: 'https://app.example/callback',
      validUntil: new Date('2026-12-01T10:00:00.000Z'),
      psuType: 'personal',
    });
    expect(out).toEqual({ url: 'https://bank.example/auth?x=1', authorizationId: 'auth-1' });
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.path).toBe('/auth');
    expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({
      aspsp: { name: 'Mock Bank', country: 'PT' },
      state: 'state-123',
      redirect_url: 'https://app.example/callback',
      psu_type: 'personal',
      access: {
        valid_until: '2026-12-01T10:00:00.000Z',
        balances: true,
        transactions: true,
      },
    });
  });

  it('rejects a non-https authorisation url', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { url: 'http://evil.example/', authorization_id: 'a' }),
    );
    await expect(
      client(server.baseUrl).startAuth({
        aspsp: { name: 'B', country: 'PT' },
        state: 's',
        redirectUrl: 'https://app.example/cb',
        validUntil: new Date(),
        psuType: 'personal',
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('creates a session and maps accounts (IBAN from account_id or all_account_ids)', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        session_id: 'sess-1',
        aspsp: { name: 'Mock Bank', country: 'PT' },
        access: { valid_until: '2026-12-01T10:00:00+00:00' },
        accounts: [
          {
            uid: 'uid-1',
            account_id: { iban: 'XX00TESTIBAN1' },
            name: 'Current',
            currency: 'EUR',
            identification_hash: 'hash-1',
          },
          {
            uid: 'uid-2',
            all_account_ids: [
              { scheme_name: 'BBAN', identification: 'bban' },
              { scheme_name: 'IBAN', identification: 'XX00TESTIBAN2' },
            ],
            currency: 'EUR',
            identification_hash: 'hash-2',
          },
          { uid: 'uid-3', currency: 'USD', identification_hash: 'hash-3', details: 'Card' },
          { uid: 'uid-4', currency: 'EUR' },
        ],
      }),
    );
    const session = await client(server.baseUrl).createSession('the-code');
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.path).toBe('/sessions');
    expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({ code: 'the-code' });
    expect(session).toEqual({
      sessionId: 'sess-1',
      aspsp: { name: 'Mock Bank', country: 'PT' },
      validUntil: '2026-12-01T10:00:00+00:00',
      pendingAccounts: [],
      accounts: [
        {
          externalUid: 'uid-1',
          externalKey: 'XX00TESTIBAN1',
          name: 'Current',
          currency: 'EUR',
          iban: 'XX00TESTIBAN1',
        },
        {
          externalUid: 'uid-2',
          externalKey: 'XX00TESTIBAN2',
          name: 'XX00TESTIBAN2',
          currency: 'EUR',
          iban: 'XX00TESTIBAN2',
        },
        { externalUid: 'uid-3', externalKey: 'hash-3', name: 'Card', currency: 'USD' },
        {
          externalUid: 'uid-4',
          externalKey: 'uid-4',
          name: 'Account',
          currency: 'EUR',
          stableKey: false,
        },
      ],
    });
  });

  it('rejects a session whose account lacks a currency', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { session_id: 's', accounts: [{ uid: 'u' }] }),
    );
    await expect(client(server.baseUrl).createSession('c')).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('reads GET /sessions accounts returned as uid strings with accounts_data hashes', async () => {
    server = await startFakeServer((_req, res) =>
      // GET /sessions/{id} carries no session_id: the id is only in the path.
      sendJson(res, {
        accounts: ['uid-1', 'uid-2'],
        accounts_data: [{ uid: 'uid-1', identification_hash: 'hash-1' }],
      }),
    );
    const session = await client(server.baseUrl).getSession('s');
    expect(session.accounts).toEqual([]);
    expect(session.pendingAccounts).toEqual([
      { uid: 'uid-1', identificationHash: 'hash-1' },
      { uid: 'uid-2' },
    ]);
  });

  it('still maps GET /sessions accounts given as objects, and mixed shapes', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        accounts: [
          { uid: 'uid-1', currency: 'EUR', account_id: { iban: 'XX00TESTIBAN1' } },
          'uid-2',
        ],
      }),
    );
    const session = await client(server.baseUrl).getSession('s');
    expect(session.accounts.map((a) => a.externalKey)).toEqual(['XX00TESTIBAN1']);
    expect(session.pendingAccounts).toEqual([{ uid: 'uid-2' }]);
  });

  it('fetches account details with the same key derivation and PSU headers', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        uid: 'uid/1',
        account_id: { iban: 'XX00TESTIBAN1' },
        name: 'Current',
        currency: 'EUR',
        identification_hash: 'hash-1',
      }),
    );
    const acc = await client(server.baseUrl).getAccountDetails('uid/1', {
      psuHeaders: { ipAddress: '203.0.113.9' },
    });
    expect(server.requests[0]?.path).toBe('/accounts/uid%2F1/details');
    expect(server.requests[0]?.headers['psu-ip-address']).toBe('203.0.113.9');
    expect(acc).toEqual({
      externalUid: 'uid/1',
      externalKey: 'XX00TESTIBAN1',
      name: 'Current',
      currency: 'EUR',
      iban: 'XX00TESTIBAN1',
    });
  });

  it('falls back to the session identification hash when details carry no key', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { uid: 'u', currency: 'EUR', details: 'Card' }),
    );
    const acc = await client(server.baseUrl).getAccountDetails('u', {
      identificationHash: 'hash-9',
    });
    expect(acc.externalKey).toBe('hash-9');
    expect(acc.stableKey).toBeUndefined();
  });

  it('gets and deletes a session (id is path-encoded)', async () => {
    server = await startFakeServer((req, res) => {
      if (req.method === 'DELETE') {
        res.statusCode = 204;
        res.end();
      } else {
        sendJson(res, { status: 'AUTHORIZED', accounts: [] });
      }
    });
    const c = client(server.baseUrl);
    const session = await c.getSession('a/b');
    expect(session.sessionId).toBe('a/b');
    expect(session.status).toBe('AUTHORIZED');
    await c.deleteSession('a/b');
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /sessions/a%2Fb',
      'DELETE /sessions/a%2Fb',
    ]);
  });

  it('maps balances to minor units with their ISO 20022 type', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        balances: [
          {
            name: 'Booked',
            balance_amount: { amount: '1234.56', currency: 'EUR' },
            balance_type: 'CLBD',
            reference_date: '2026-03-01',
          },
          {
            balance_amount: { amount: '-10.00', currency: 'EUR' },
            balance_type: 'ITAV',
            last_change_date_time: '2026-03-02T08:00:00Z',
          },
        ],
      }),
    );
    const out = await client(server.baseUrl, { now: () => Date.UTC(2026, 2, 3) }).getBalances(
      'uid-1',
    );
    expect(server.requests[0]?.path).toBe('/accounts/uid-1/balances');
    expect(out).toEqual([
      { externalUid: 'uid-1', asOf: '2026-03-01', amount: 123456, currency: 'EUR', kind: 'CLBD' },
      {
        externalUid: 'uid-1',
        asOf: '2026-03-02T08:00:00Z',
        amount: -1000,
        currency: 'EUR',
        kind: 'ITAV',
      },
    ]);
  });

  it('follows continuation_key, sends the date window and skips cancelled rows', async () => {
    server = await startFakeServer((req, res) => {
      const url = new URL(req.path, 'http://x');
      if (url.searchParams.get('continuation_key') === 'k1') {
        sendJson(res, { transactions: [tx('3')], continuation_key: null });
      } else {
        sendJson(res, {
          transactions: [tx('1'), tx('2', { status: 'CNCL' })],
          continuation_key: 'k1',
        });
      }
    });
    const out = await client(server.baseUrl).listTransactions('uid-1', {
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      accountCurrency: 'EUR',
    });
    expect(out.map((t) => t.externalId)).toEqual(['1', '3']);
    const first = new URL(server.requests[0]?.path ?? '', 'http://x');
    expect(first.pathname).toBe('/accounts/uid-1/transactions');
    expect(first.searchParams.get('date_from')).toBe('2026-03-01');
    expect(first.searchParams.get('date_to')).toBe('2026-03-31');
    expect(first.searchParams.has('continuation_key')).toBe(false);
    expect(
      new URL(server.requests[1]?.path ?? '', 'http://x').searchParams.get('continuation_key'),
    ).toBe('k1');
  });

  it('reports every page request through onPage, including a failing one', async () => {
    let n = 0;
    server = await startFakeServer((_req, res) => {
      n += 1;
      if (n === 3) res.writeHead(503).end();
      else sendJson(res, { transactions: [], continuation_key: `k${n}` });
    });
    let pages = 0;
    await expect(
      client(server.baseUrl).listTransactions('uid-1', {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-31',
        onPage: () => (pages += 1),
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(pages).toBe(3);
  });

  it('forwards PSU headers on balances and transactions, only the non-empty ones', async () => {
    server = await startFakeServer((req, res) =>
      sendJson(res, req.path.includes('balances') ? { balances: [] } : { transactions: [] }),
    );
    const c = client(server.baseUrl);
    await c.getBalances('uid-1', {
      psuHeaders: { ipAddress: '203.0.113.7', userAgent: 'Agent/1' },
    });
    await c.listTransactions('uid-1', {
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      psuHeaders: { ipAddress: '203.0.113.7', userAgent: '' },
    });
    await c.getBalances('uid-1', { psuHeaders: { ipAddress: '', userAgent: undefined } });
    await c.getBalances('uid-1');
    const [balances, txs, emptyBalances, plainBalances] = server.requests.map((r) => r.headers);
    expect(balances?.['psu-ip-address']).toBe('203.0.113.7');
    expect(balances?.['psu-user-agent']).toBe('Agent/1');
    expect(txs?.['psu-ip-address']).toBe('203.0.113.7');
    expect(txs && 'psu-user-agent' in txs).toBe(false);
    for (const h of [emptyBalances, plainBalances]) {
      expect(h && 'psu-ip-address' in h).toBe(false);
      expect(h && 'psu-user-agent' in h).toBe(false);
    }
  });

  it('skips rows that cannot be mapped and reports each one, keeping the rest', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, {
        transactions: [
          tx('1'),
          tx('2', { credit_debit_indicator: 'WHAT' }),
          'not an object',
          tx('3', { transaction_amount: { amount: '12.345', currency: 'EUR' } }),
          tx('4'),
        ],
      }),
    );
    let skipped = 0;
    const out = await client(server.baseUrl).listTransactions('uid-1', {
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
      onSkippedRow: () => {
        skipped += 1;
      },
    });
    expect(out.map((t) => t.externalId)).toEqual(['1', '4']);
    expect(skipped).toBe(3);
  });

  it('still fails the whole call when the envelope is malformed', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { transactions: 'nope' }));
    await expect(
      client(server.baseUrl).listTransactions('u', {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-31',
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('throws ProviderResponseError when the page guard is exceeded', async () => {
    server = await startFakeServer((_req, res, i) =>
      sendJson(res, { transactions: [tx(String(i))], continuation_key: `k${i}` }),
    );
    await expect(
      client(server.baseUrl, { maxPages: 3 }).listTransactions('u', {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-31',
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(server.requests).toHaveLength(3);
  });

  it('throws ProviderResponseError on a repeated continuation_key', async () => {
    server = await startFakeServer((_req, res) =>
      sendJson(res, { transactions: [], continuation_key: 'same' }),
    );
    await expect(
      client(server.baseUrl).listTransactions('u', {
        dateFrom: '2026-03-01',
        dateTo: '2026-03-31',
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(server.requests).toHaveLength(2);
  });

  it('maps 401 to ProviderAuthError', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, { message: 'expired' }, 401));
    await expect(client(server.baseUrl).getBalances('u')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps 429 with Retry-After to ProviderRateLimitError without retrying (PSD2 call budget)', async () => {
    server = await startFakeServer((_req, res) => sendJson(res, {}, 429, { 'retry-after': '30' }));
    const err = await client(server.baseUrl)
      .getBalances('u')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterSeconds).toBe(30);
    expect(server.requests).toHaveLength(1);
  });

  it('maps malformed JSON and unexpected shapes to ProviderResponseError', async () => {
    server = await startFakeServer((req, res) => {
      if (req.path.startsWith('/aspsps')) {
        res.writeHead(200);
        res.end('<html>');
      } else {
        sendJson(res, { unexpected: true });
      }
    });
    const c = client(server.baseUrl);
    await expect(c.listAspsps('PT')).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(c.getBalances('u')).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(
      c.listTransactions('u', { dateFrom: '2026-03-01', dateTo: '2026-03-31' }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });
});
