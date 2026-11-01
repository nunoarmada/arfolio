import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A rate-limit wait longer than this is not worth blocking a worker for: fail instead. */
export const MAX_RETRY_AFTER_SECONDS = 60;

export type HttpConfig = {
  /** Provider name used in error messages (never a URL: paths can contain session ids). */
  label: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Retries after a 429 (0 = fail on the first 429). */
  maxRetries?: number;
  timeoutMs?: number;
};

export type HttpRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  body?: unknown;
  /** Set to false for endpoints that answer with an empty body (e.g. DELETE). */
  expectJson?: boolean;
};

export type HttpResponse = { json: unknown; headers: Headers };

export type Http = { request(req: HttpRequest): Promise<HttpResponse> };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Parses `Retry-After` (seconds or HTTP date), falling back to `x-ratelimit-reset`
 * (unix seconds). Returns whole seconds to wait, or undefined when no hint was sent.
 */
function retryAfterSeconds(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - nowMs) / 1000));
  }
  const resetHeader = headers.get('x-ratelimit-reset');
  const reset = Number(resetHeader);
  if (resetHeader !== null && resetHeader.trim() !== '' && Number.isFinite(reset)) {
    return Math.max(0, Math.ceil(reset - nowMs / 1000));
  }
  return undefined;
}

/** JSON-over-HTTP with provider error mapping and bounded 429 backoff. */
export function createHttp(config: HttpConfig): Http {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? Date.now;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { label } = config;

  async function attempt(req: HttpRequest): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(typeof req.headers === 'function' ? req.headers() : req.headers),
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }
    try {
      return await doFetch(req.url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ProviderUnavailableError(`${label} is unreachable`);
    }
  }

  return {
    async request(req) {
      for (let retries = 0; ; retries++) {
        const res = await attempt(req);
        if (res.ok) {
          if (req.expectJson === false) {
            await res.body?.cancel();
            return { json: undefined, headers: res.headers };
          }
          let text: string;
          try {
            text = await res.text();
          } catch {
            // Body read failure or timeout abort mid-stream: transient, not a bad payload.
            throw new ProviderUnavailableError(`${label} response was interrupted`);
          }
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new ProviderResponseError(`${label} returned malformed JSON`);
          }
          return { json, headers: res.headers };
        }
        await res.body?.cancel();

        const { status } = res;
        if (status === 401 || status === 403) {
          throw new ProviderAuthError(`${label} rejected the credentials (HTTP ${status})`);
        }
        if (status === 429) {
          const wait = retryAfterSeconds(res.headers, now());
          const message = `${label} rate limit exceeded (HTTP 429)`;
          if (retries >= maxRetries || (wait !== undefined && wait > MAX_RETRY_AFTER_SECONDS)) {
            throw new ProviderRateLimitError(wait, message);
          }
          // Without a hint, back off exponentially: 1 s, 2 s, 4 s.
          await sleep((wait ?? 2 ** retries) * 1000);
          continue;
        }
        if (status >= 500) {
          throw new ProviderUnavailableError(`${label} is unavailable (HTTP ${status})`);
        }
        throw new ProviderResponseError(`${label} rejected the request (HTTP ${status})`, status);
      }
    },
  };
}
