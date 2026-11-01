/**
 * Fake provider servers for the e2e run: Enable Banking (JWT-checked, with a consent redirect the
 * spec simulates) and Trading 212. They speak just enough of the real APIs for the connectors in
 * packages/connectors to work against them; no real provider is ever contacted.
 */
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeServer {
  /** Origin without trailing slash, e.g. http://127.0.0.1:41234 */
  url: string;
  close(): Promise<void>;
}

/** The host the fake bank "lives" on: https (the connector insists), intercepted by the spec. */
export const FAKE_BANK_ORIGIN = 'https://bank.example.test';
export const FAKE_BANK_NAME = 'Banco Exemplo';
export const FAKE_BETA_BANK_NAME = 'Crédito Fictício';
export const FAKE_BANK_IBAN = 'PT50000201231234567890154';
export const FAKE_T212 = { key: 'e2e-t212-key', secret: 'e2e-t212-secret' };
/** Valid keys of a different Trading 212 account: a key update must refuse them. */
export const FAKE_T212_OTHER = { key: 'e2e-t212-other-key', secret: 'e2e-t212-other-secret' };
/** A freshly issued key pair of the same account (as after the old one was revoked). */
export const FAKE_T212_RENEWED = { key: 'e2e-t212-new-key', secret: 'e2e-t212-new-secret' };

function listen(server: Server): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

const isoDay = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** Verifies the RS256 JWT the app signs with the key pair the runner generated. */
function validJwt(header: string | undefined, publicKeyPem: string, appId: string): boolean {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const [head, payload, signature] = token.split('.');
  if (!head || !payload || !signature) return false;
  try {
    const kid = (JSON.parse(Buffer.from(head, 'base64url').toString()) as { kid?: string }).kid;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number };
    if (kid !== appId || (claims.exp ?? 0) * 1000 < Date.now()) return false;
    return createVerify('RSA-SHA256')
      .update(`${head}.${payload}`)
      .verify(createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export async function startFakeEnableBanking(opts: {
  appId: string;
  publicKeyPem: string;
}): Promise<FakeServer> {
  const sessions = new Map<string, { validUntil: string; unstable: boolean }>();
  const usedCodes = new Set<string>();
  const session = (id: string) => ({
    session_id: id,
    aspsp: {
      name: sessions.get(id)!.unstable ? FAKE_BETA_BANK_NAME : FAKE_BANK_NAME,
      country: 'PT',
    },
    status: 'AUTHORIZED',
    access: { valid_until: sessions.get(id)!.validUntil },
    accounts: [
      {
        uid: `uid-${createHash('sha1').update(id).digest('hex').slice(0, 10)}`,
        account_id: { iban: FAKE_BANK_IBAN },
        name: 'Conta Ordem',
        currency: 'EUR',
      },
      // The beta bank also shares an account with no IBAN and no stable hash: only its session
      // uid identifies it, so a renewal could not find it again.
      ...(sessions.get(id)!.unstable
        ? [{ uid: `uid-nokey-${id.slice(-6)}`, name: 'Conta sem IBAN', currency: 'EUR' }]
        : []),
    ],
  });

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      if (!validJwt(req.headers.authorization, opts.publicKeyPem, opts.appId)) {
        return send(res, 401, { message: 'invalid token' });
      }
      const path = url.pathname;

      if (req.method === 'GET' && path === '/aspsps') {
        const country = url.searchParams.get('country');
        return send(res, 200, {
          aspsps:
            country === 'PT'
              ? [
                  {
                    name: FAKE_BANK_NAME,
                    country: 'PT',
                    maximum_consent_validity: 90 * 86_400,
                    // The UI does not load logos (CSP): this URL must never be requested.
                    logo: 'https://logos.example.test/banco-exemplo.png',
                    required_psu_headers: [],
                    psu_types: ['personal'],
                  },
                  {
                    name: FAKE_BETA_BANK_NAME,
                    country: 'PT',
                    maximum_consent_validity: 180 * 86_400,
                    beta: true,
                    required_psu_headers: [],
                    psu_types: ['personal'],
                  },
                ]
              : [],
        });
      }

      if (req.method === 'POST' && path === '/auth') {
        const body = await readJson(req);
        const id = randomBytes(6).toString('hex');
        const target = new URL('/authorise', FAKE_BANK_ORIGIN);
        target.searchParams.set('authorization', id);
        target.searchParams.set(
          'aspsp',
          String((body.aspsp as { name?: string } | undefined)?.name),
        );
        target.searchParams.set('state', String(body.state));
        target.searchParams.set('redirect_url', String(body.redirect_url));
        return send(res, 200, { url: target.toString(), authorization_id: id });
      }

      if (req.method === 'POST' && path === '/sessions') {
        const { code } = (await readJson(req)) as { code?: string };
        if (typeof code !== 'string' || !code.startsWith('fakecode-') || usedCodes.has(code)) {
          return send(res, 422, { message: 'invalid code' });
        }
        usedCodes.add(code);
        const id = `sess-${randomBytes(6).toString('hex')}`;
        sessions.set(id, {
          validUntil: new Date(Date.now() + 89 * 86_400_000).toISOString(),
          unstable: code.includes('unstable'),
        });
        return send(res, 200, session(id));
      }

      const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]!);
        if (!sessions.has(id)) return send(res, 404, { message: 'unknown session' });
        if (req.method === 'GET') return send(res, 200, session(id));
        if (req.method === 'DELETE') {
          sessions.delete(id);
          return send(res, 204);
        }
      }

      if (req.method === 'GET' && /^\/accounts\/[^/]+\/balances$/.test(path)) {
        return send(res, 200, {
          balances: [
            {
              balance_amount: { currency: 'EUR', amount: '1234.56' },
              balance_type: 'CLBD',
              reference_date: isoDay(0),
            },
          ],
        });
      }

      if (req.method === 'GET' && /^\/accounts\/[^/]+\/transactions$/.test(path)) {
        const row = (
          id: string,
          daysAgo: number,
          amount: string,
          indicator: 'DBIT' | 'CRDT',
          party: string,
          text: string,
        ) => ({
          transaction_id: id,
          status: 'BOOK',
          credit_debit_indicator: indicator,
          transaction_amount: { currency: 'EUR', amount },
          booking_date: isoDay(daysAgo),
          value_date: isoDay(daysAgo),
          [indicator === 'DBIT' ? 'creditor' : 'debtor']: { name: party },
          remittance_information: [text],
        });
        return send(res, 200, {
          transactions: [
            row('e2e-tx-1', 1, '42.30', 'DBIT', 'Continente Modelo', 'COMPRA CONTINENTE 4711'),
            row('e2e-tx-2', 2, '1500.00', 'CRDT', 'Empresa Exemplo Lda', 'ORDENADO OUTUBRO'),
            row('e2e-tx-3', 3, '12.50', 'DBIT', 'Padaria Central', 'COMPRA PADARIA CENTRAL'),
          ],
        });
      }

      return send(res, 404, { message: 'not found' });
    })().catch(() => send(res, 500, { message: 'fake error' }));
  });
  return listen(server);
}

export async function startFakeTrading212(): Promise<FakeServer> {
  const basic = (pair: { key: string; secret: string }) =>
    `Basic ${Buffer.from(`${pair.key}:${pair.secret}`).toString('base64')}`;
  // Two key pairs of the same account (id 424242) and one of another account (id 737373).
  const accounts = new Map([
    [basic(FAKE_T212), 424242],
    [basic(FAKE_T212_RENEWED), 424242],
    [basic(FAKE_T212_OTHER), 737373],
  ]);
  const server = createServer((req, res) => {
    const accountId = accounts.get(req.headers.authorization ?? '');
    if (accountId === undefined) return send(res, 401, { message: 'unauthorised' });
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    if (path === '/api/v0/equity/account/summary') {
      return send(res, 200, {
        id: accountId,
        currency: 'EUR',
        totalValue: 1500.5,
        cash: { availableToTrade: 500.25, inPies: 0, reservedForOrders: 0 },
        investments: { currentValue: 1000.25 },
      });
    }
    if (path === '/api/v0/equity/positions') return send(res, 200, []);
    if (path === '/api/v0/equity/history/transactions') {
      return send(res, 200, {
        items: [
          {
            reference: 'E2EDEP1',
            type: 'DEPOSIT',
            amount: 250,
            currency: 'EUR',
            dateTime: `${isoDay(1)}T10:00:00Z`,
          },
        ],
      });
    }
    if (path === '/api/v0/equity/history/dividends') return send(res, 200, { items: [] });
    return send(res, 404, { message: 'not found' });
  });
  return listen(server);
}
