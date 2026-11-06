import { array, optString, record, reqString } from '../guards.js';
import { createHttp, type Http } from '../http.js';
import { ProviderResponseError, ProviderUnavailableError, type ProviderTx } from '../types.js';
import {
  mapTrading212Dividend,
  mapTrading212Pie,
  mapTrading212PieDetail,
  mapTrading212Position,
  mapTrading212Transaction,
  parseTrading212Summary,
  type ProviderPie,
  type ProviderPieDetail,
  type ProviderPosition,
  type Trading212Summary,
} from './map.js';

const PAGE_LIMIT = 50;
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type Trading212Config = {
  apiKey: string;
  apiSecret: string;
  /** e.g. `https://live.trading212.com/api/v0` or the demo equivalent. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Upper bound on `nextPagePath` pages per list call. */
  maxPages?: number;
  /** 429 retries per request (Retry-After is honoured, capped at 60 s). */
  maxRetries?: number;
  timeoutMs?: number;
  /** Size cap for a downloaded history export (default 20 MB). */
  maxExportBytes?: number;
};

export type HistoryExport = {
  reportId: number;
  status: string;
  /** Pre-signed URL on another host, present once the export is `Finished`. */
  downloadLink?: string;
};

export type HistoryPage = {
  items: ProviderTx[];
  /** True when a later page 404'd (known upstream bug): items fetched so far are kept. */
  incomplete: boolean;
};

export function createTrading212Client(config: Trading212Config) {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const authorization = `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64')}`;
  const maxExportBytes = config.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
  const http: Http = createHttp({
    label: 'Trading 212',
    fetch: config.fetch,
    sleep: config.sleep,
    now: config.now,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  });

  async function get(url: string): Promise<unknown> {
    return (await http.request({ method: 'GET', url, headers: { authorization } })).json;
  }

  async function post(url: string, body: unknown): Promise<unknown> {
    return (await http.request({ method: 'POST', url, headers: { authorization }, body })).json;
  }

  /** `nextPagePath` is a path on the same host; it may or may not include the `/api/v0` prefix. */
  function resolveNextPage(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new ProviderResponseError('Unexpected response: nextPagePath is not a relative path');
    }
    const prefixed =
      basePath !== '' &&
      (path === basePath || path.startsWith(`${basePath}/`) || path.startsWith(`${basePath}?`));
    return prefixed ? `${new URL(baseUrl).origin}${path}` : `${baseUrl}${path}`;
  }

  async function paginate(
    firstPath: string,
    map: (raw: unknown) => ProviderTx,
    since: string | undefined,
    marginPages: number,
  ): Promise<HistoryPage> {
    const items: ProviderTx[] = [];
    const seen = new Set<string>();
    // Pages still to read once a page has reached back past `since` (undefined until then).
    let pagesLeft: number | undefined;
    let url = `${baseUrl}${firstPath}`;
    for (let page = 0; page < maxPages; page++) {
      let body: unknown;
      try {
        body = await get(url);
      } catch (e) {
        // Later transaction pages are known to 404; keep what we have and flag it.
        if (page > 0 && e instanceof ProviderResponseError && e.status === 404) {
          return { items, incomplete: true };
        }
        throw e;
      }
      const parsed = record(body, 'history response');
      let oldest: string | undefined;
      for (const raw of array(parsed.items, 'items')) {
        const row = map(raw);
        if (oldest === undefined || row.bookingDate < oldest) oldest = row.bookingDate;
        if (since === undefined || row.bookingDate >= since) items.push(row);
      }
      const next = optString(parsed.nextPagePath);
      if (next === undefined) return { items, incomplete: false };
      // The history is newest first: once a page reaches older than `since`, the rest only
      // holds older rows, so the walk (6 requests a minute upstream) can end here.
      if (
        pagesLeft === undefined &&
        since !== undefined &&
        oldest !== undefined &&
        oldest < since
      ) {
        pagesLeft = marginPages;
      }
      if (pagesLeft !== undefined) {
        if (pagesLeft === 0) return { items, incomplete: false };
        pagesLeft -= 1;
      }
      if (seen.has(next)) {
        throw new ProviderResponseError('Unexpected response: nextPagePath repeated');
      }
      seen.add(next);
      url = resolveNextPage(next);
    }
    throw new ProviderResponseError(`History pagination exceeded ${maxPages} pages`);
  }

  return {
    async getAccountSummary(): Promise<Trading212Summary> {
      return parseTrading212Summary(await get(`${baseUrl}/equity/account/summary`));
    },

    async getPositions(): Promise<ProviderPosition[]> {
      return array(await get(`${baseUrl}/equity/positions`), 'positions').map(
        mapTrading212Position,
      );
    },

    /** Pies with invested/value in minor units of `currency` (the account currency). 1 request / 30 s. */
    async listPies(currency: string): Promise<ProviderPie[]> {
      return array(await get(`${baseUrl}/equity/pies`), 'pies').map((raw) =>
        mapTrading212Pie(raw, currency),
      );
    },

    /**
     * Pie name and held instruments (minor units of `currency`, the account currency) from its
     * detail. 1 request / 5 s: call sequentially.
     */
    async getPieDetail(id: string, currency: string): Promise<ProviderPieDetail> {
      if (!/^\d+$/.test(id)) {
        throw new ProviderResponseError('Unexpected response: pie id is not an integer');
      }
      return mapTrading212PieDetail(await get(`${baseUrl}/equity/pies/${id}`), currency);
    },

    /** There is no server-side date filter: the history is walked and filtered by `since` (YYYY-MM-DD). */
    listTransactions(opts: { since?: string }): Promise<HistoryPage> {
      return paginate(
        `/equity/history/transactions?limit=${PAGE_LIMIT}`,
        mapTrading212Transaction,
        opts.since,
        0,
      );
    },

    /** Asks for a transactions-only CSV export (1 request / 30 s per account, max 1 year). */
    async requestHistoryExport(range: { timeFrom: string; timeTo: string }): Promise<number> {
      const body = record(
        await post(`${baseUrl}/history/exports`, {
          dataIncluded: {
            includeOrders: false,
            includeDividends: false,
            includeTransactions: true,
            includeInterest: false,
          },
          timeFrom: range.timeFrom,
          timeTo: range.timeTo,
        }),
        'export response',
      );
      if (typeof body.reportId !== 'number' || !Number.isInteger(body.reportId)) {
        throw new ProviderResponseError('Unexpected response: reportId is not a number');
      }
      return body.reportId;
    },

    async listHistoryExports(): Promise<HistoryExport[]> {
      return array(await get(`${baseUrl}/history/exports`), 'exports').map((raw) => {
        const item = record(raw, 'export');
        if (typeof item.reportId !== 'number') {
          throw new ProviderResponseError('Unexpected response: export reportId is not a number');
        }
        const downloadLink = optString(item.downloadLink);
        return {
          reportId: item.reportId,
          status: reqString(item.status, 'export status'),
          ...(downloadLink !== undefined ? { downloadLink } : {}),
        };
      });
    },

    /** The link is pre-signed on another host: fetched over https and WITHOUT our credentials. */
    async downloadHistoryExport(url: string): Promise<string> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ProviderResponseError('Unexpected response: export link is not a URL');
      }
      if (parsed.protocol !== 'https:') {
        throw new ProviderResponseError('Unexpected response: export link is not https');
      }
      let res: Response;
      try {
        res = await (config.fetch ?? fetch)(parsed.href, {
          method: 'GET',
          signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch {
        throw new ProviderUnavailableError('Trading 212 export download is unreachable');
      }
      // fetch follows redirects: the final hop must still be https.
      if (res.redirected && !res.url.startsWith('https:')) {
        await res.body?.cancel();
        throw new ProviderResponseError('Unexpected response: export link is not https');
      }
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status >= 500) {
          throw new ProviderUnavailableError(
            `Trading 212 export download is unavailable (HTTP ${res.status})`,
          );
        }
        throw new ProviderResponseError(
          `Trading 212 export download was rejected (HTTP ${res.status})`,
          res.status,
        );
      }
      const tooLarge = () => new ProviderResponseError('Trading 212 export is too large');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxExportBytes) {
        await res.body?.cancel();
        throw tooLarge();
      }
      const reader = res.body?.getReader();
      if (!reader) return '';
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxExportBytes) {
            await reader.cancel();
            throw tooLarge();
          }
          parts.push(value);
        }
      } catch (e) {
        if (e instanceof ProviderResponseError) throw e;
        throw new ProviderUnavailableError('Trading 212 export download was interrupted');
      }
      return Buffer.concat(parts).toString('utf8');
    },

    listDividends(opts: { since?: string }): Promise<HistoryPage> {
      return paginate(
        `/equity/history/dividends?limit=${PAGE_LIMIT}`,
        mapTrading212Dividend,
        opts.since,
        // Dividends are keyed by payment date and not strictly chronological: one page of margin.
        1,
      );
    },
  };
}

export type Trading212Client = ReturnType<typeof createTrading212Client>;
