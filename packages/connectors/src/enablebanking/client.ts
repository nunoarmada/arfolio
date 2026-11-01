import { array, optString, record, reqString, type Json } from '../guards.js';
import { createHttp, type Http } from '../http.js';
import {
  ProviderResponseError,
  type ExternalAccount,
  type ProviderBalance,
  type ProviderTx,
} from '../types.js';
import { createJwtSigner } from './jwt.js';
import {
  isIngestibleEnableBankingStatus,
  mapEnableBankingBalance,
  mapEnableBankingTransaction,
} from './map.js';

const DEFAULT_BASE_URL = 'https://api.enablebanking.com';
const DEFAULT_MAX_PAGES = 50;

export type EnableBankingConfig = {
  appId: string;
  privateKeyPem: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Upper bound on `continuation_key` pages per `listTransactions` call. */
  maxPages?: number;
  timeoutMs?: number;
};

/**
 * What the bank needs to treat a call as made with the user present (PSD2 budgets unattended
 * calls). Only non-empty values are sent; scheduled runs pass none.
 */
export type PsuHeaders = { ipAddress?: string; userAgent?: string };

function psuHeaderMap(psu: PsuHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (psu?.ipAddress) out['Psu-Ip-Address'] = psu.ipAddress;
  if (psu?.userAgent) out['Psu-User-Agent'] = psu.userAgent;
  return out;
}

export type Aspsp = {
  name: string;
  country: string;
  maximumConsentValiditySeconds?: number;
  /** Provider-hosted logo URL, when listed. */
  logo?: string;
  /** True when the provider flags the integration as beta. */
  beta?: boolean;
  requiredPsuHeaders: string[];
  psuTypes: string[];
};

export type EnableBankingSession = {
  sessionId: string;
  aspsp?: { name: string; country: string };
  validUntil?: string;
  status?: string;
  /** Accounts the session returned as full resources (`POST /sessions`). */
  accounts: ExternalAccount[];
  /**
   * Accounts `GET /sessions/{id}` returned as bare uid strings: details are fetched per account
   * with `getAccountDetails`. `identificationHash` comes from `accounts_data` when present.
   */
  pendingAccounts: Array<{ uid: string; identificationHash?: string }>;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function mapAccount(raw: unknown, fallbackHash?: string): ExternalAccount {
  const acc = record(raw, 'account');
  const uid = reqString(acc.uid, 'account uid');
  const currency = reqString(acc.currency, 'account currency');
  const accountId =
    acc.account_id === undefined || acc.account_id === null
      ? {}
      : record(acc.account_id, 'account_id');
  let iban = optString(accountId.iban);
  if (iban === undefined && Array.isArray(acc.all_account_ids)) {
    for (const entry of acc.all_account_ids) {
      if (typeof entry === 'object' && entry !== null) {
        const e = entry as Json;
        if (e.scheme_name === 'IBAN') iban ??= optString(e.identification);
      }
    }
  }
  const name = optString(acc.name) ?? optString(acc.details) ?? iban ?? 'Account';
  const stable = iban ?? optString(acc.identification_hash) ?? fallbackHash;
  return {
    externalUid: uid,
    externalKey: stable ?? uid,
    ...(stable === undefined ? { stableKey: false as const } : {}),
    name,
    currency,
    ...(iban !== undefined ? { iban } : {}),
  };
}

// `knownId`: GET /sessions/{id} carries no session_id in its body, only in the path.
function mapSession(raw: unknown, knownId?: string): EnableBankingSession {
  const s = record(raw, 'session');
  const aspsp = s.aspsp === undefined || s.aspsp === null ? undefined : record(s.aspsp, 'aspsp');
  const access =
    s.access === undefined || s.access === null ? undefined : record(s.access, 'access');
  const name = optString(aspsp?.name);
  const country = optString(aspsp?.country);
  const validUntil = optString(access?.valid_until);
  const status = optString(s.status);
  const hashes = new Map<string, string>();
  for (const entry of Array.isArray(s.accounts_data) ? s.accounts_data : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Json;
    const uid = optString(e.uid);
    const hash = optString(e.identification_hash);
    if (uid !== undefined && hash !== undefined) hashes.set(uid, hash);
  }
  // POST /sessions returns full account resources; GET /sessions/{id} returns bare uid strings.
  const accounts: ExternalAccount[] = [];
  const pendingAccounts: EnableBankingSession['pendingAccounts'] = [];
  for (const entry of array(s.accounts ?? [], 'accounts')) {
    if (typeof entry === 'string' && entry !== '') {
      const identificationHash = hashes.get(entry);
      pendingAccounts.push({ uid: entry, ...(identificationHash ? { identificationHash } : {}) });
    } else {
      accounts.push(mapAccount(entry));
    }
  }
  return {
    sessionId: knownId ?? reqString(s.session_id, 'session_id'),
    ...(name !== undefined && country !== undefined ? { aspsp: { name, country } } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    ...(status !== undefined ? { status } : {}),
    accounts,
    pendingAccounts,
  };
}

export function createEnableBankingClient(config: EnableBankingConfig) {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const now = config.now ?? Date.now;
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const signer = createJwtSigner({ appId: config.appId, privateKeyPem: config.privateKeyPem, now });
  // PSD2 budgets calls per account per day: a 429 is surfaced, never retried in-process.
  const http: Http = createHttp({
    label: 'Enable Banking',
    fetch: config.fetch,
    sleep: config.sleep,
    now,
    maxRetries: 0,
    timeoutMs: config.timeoutMs,
  });
  const auth = () => ({ authorization: `Bearer ${signer.getToken()}` });
  const enc = encodeURIComponent;

  async function get(
    path: string,
    query?: Record<string, string>,
    psu?: PsuHeaders,
  ): Promise<unknown> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const extra = psuHeaderMap(psu);
    return (
      await http.request({
        method: 'GET',
        url: `${baseUrl}${path}${qs}`,
        headers: () => ({ ...auth(), ...extra }),
      })
    ).json;
  }

  return {
    async listAspsps(country: string): Promise<Aspsp[]> {
      const body = record(await get('/aspsps', { country }), 'aspsps response');
      return array(body.aspsps, 'aspsps').map((raw) => {
        const a = record(raw, 'aspsp');
        const validity = a.maximum_consent_validity;
        return {
          name: reqString(a.name, 'aspsp name'),
          country: reqString(a.country, 'aspsp country'),
          ...(typeof validity === 'number' && Number.isFinite(validity)
            ? { maximumConsentValiditySeconds: validity }
            : {}),
          ...(typeof a.logo === 'string' && a.logo !== '' ? { logo: a.logo } : {}),
          ...(typeof a.beta === 'boolean' ? { beta: a.beta } : {}),
          requiredPsuHeaders: strings(a.required_psu_headers),
          psuTypes: strings(a.psu_types),
        };
      });
    },

    async startAuth(input: {
      aspsp: { name: string; country: string };
      state: string;
      redirectUrl: string;
      validUntil: Date;
      psuType: 'personal' | 'business';
    }): Promise<{ url: string; authorizationId?: string }> {
      const { json } = await http.request({
        method: 'POST',
        url: `${baseUrl}/auth`,
        headers: auth,
        body: {
          aspsp: { name: input.aspsp.name, country: input.aspsp.country },
          state: input.state,
          redirect_url: input.redirectUrl,
          psu_type: input.psuType,
          access: {
            valid_until: input.validUntil.toISOString(),
            balances: true,
            transactions: true,
          },
        },
      });
      const body = record(json, 'auth response');
      const url = reqString(body.url, 'auth url');
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new ProviderResponseError('Unexpected response: auth url is invalid');
      }
      if (protocol !== 'https:') {
        throw new ProviderResponseError('Unexpected response: auth url is not https');
      }
      const authorizationId = optString(body.authorization_id);
      return { url, ...(authorizationId !== undefined ? { authorizationId } : {}) };
    },

    async createSession(code: string): Promise<EnableBankingSession> {
      const { json } = await http.request({
        method: 'POST',
        url: `${baseUrl}/sessions`,
        headers: auth,
        body: { code },
      });
      return mapSession(json);
    },

    async getSession(id: string): Promise<EnableBankingSession> {
      return mapSession(await get(`/sessions/${enc(id)}`), id);
    },

    /** `GET /accounts/{uid}/details`: the full account resource for a uid-only session entry. */
    async getAccountDetails(
      uid: string,
      opts: { psuHeaders?: PsuHeaders; identificationHash?: string } = {},
    ): Promise<ExternalAccount> {
      const raw = record(
        await get(`/accounts/${enc(uid)}/details`, undefined, opts.psuHeaders),
        'account details',
      );
      // Details of an account are keyed by the uid we asked for when the body omits it.
      return mapAccount({ ...raw, uid: raw.uid ?? uid }, opts.identificationHash);
    },

    async deleteSession(id: string): Promise<void> {
      await http.request({
        method: 'DELETE',
        url: `${baseUrl}/sessions/${enc(id)}`,
        headers: auth,
        expectJson: false,
      });
    },

    async getBalances(
      uid: string,
      opts: { psuHeaders?: PsuHeaders } = {},
    ): Promise<ProviderBalance[]> {
      const body = record(
        await get(`/accounts/${enc(uid)}/balances`, undefined, opts.psuHeaders),
        'balances response',
      );
      return array(body.balances, 'balances').map((raw) =>
        mapEnableBankingBalance(raw, uid, new Date(now()).toISOString()),
      );
    },

    /**
     * Follows `continuation_key` (bounded by `maxPages`) and maps rows. Cancelled/rejected rows
     * are dropped. A row that cannot be mapped is skipped and reported through `onSkippedRow`
     * (never with its content): one bad row must not block the account. `accountCurrency` is
     * only a fallback for rows without a currency.
     */
    async listTransactions(
      uid: string,
      opts: {
        dateFrom: string;
        dateTo: string;
        accountCurrency?: string;
        psuHeaders?: PsuHeaders;
        onSkippedRow?: () => void;
        /** Called before each page request (successful or not), so callers can count calls. */
        onPage?: () => void;
      },
    ): Promise<ProviderTx[]> {
      const out: ProviderTx[] = [];
      const seenKeys = new Set<string>();
      let continuationKey: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const query: Record<string, string> = { date_from: opts.dateFrom, date_to: opts.dateTo };
        if (continuationKey !== undefined) query.continuation_key = continuationKey;
        opts.onPage?.();
        const body = record(
          await get(`/accounts/${enc(uid)}/transactions`, query, opts.psuHeaders),
          'transactions response',
        );
        for (const raw of array(body.transactions, 'transactions')) {
          try {
            if (!isIngestibleEnableBankingStatus(record(raw, 'transaction').status)) continue;
            out.push(mapEnableBankingTransaction(raw, opts.accountCurrency));
          } catch (error) {
            if (!(error instanceof ProviderResponseError)) throw error;
            opts.onSkippedRow?.();
          }
        }
        const next = optString(body.continuation_key);
        if (next === undefined) return out;
        if (seenKeys.has(next)) {
          throw new ProviderResponseError('Unexpected response: continuation_key repeated');
        }
        seenKeys.add(next);
        continuationKey = next;
      }
      throw new ProviderResponseError(`Transaction pagination exceeded ${maxPages} pages`);
    },
  };
}

export type EnableBankingClient = ReturnType<typeof createEnableBankingClient>;
