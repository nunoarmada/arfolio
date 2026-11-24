import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';

export type AnthropicPingResult =
  | { ok: true; unavailableModels: string[] }
  | { ok: false; reason: 'invalid_key' | 'rate_limited' | 'unreachable' | 'unavailable' };

const PING_TIMEOUT_MS = 10_000;

type PingFailure = Extract<AnthropicPingResult, { ok: false }>;

function failureOf(error: unknown): PingFailure {
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
    return { ok: false, reason: 'unreachable' };
  }
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || status === 403) return { ok: false, reason: 'invalid_key' };
  if (status === 429) return { ok: false, reason: 'rate_limited' };
  return { ok: false, reason: 'unavailable' };
}

/**
 * Checks an Anthropic API key with the cheapest call the API offers: listing one model. When the
 * key works, each distinct id in `models` is looked up (`GET /v1/models/{id}`) and the ones the
 * API does not know (HTTP 404) are returned in `unavailableModels`. It sends no user data, uses
 * no tokens and never retries. A failure carries a fixed reason, never the SDK's error text,
 * because that text can quote the key.
 */
export async function pingAnthropic(
  apiKey: string,
  opts: { fetch?: typeof fetch; models?: readonly string[] } = {},
): Promise<AnthropicPingResult> {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: PING_TIMEOUT_MS,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  try {
    await client.models.list({ limit: 1 });
  } catch (error) {
    return failureOf(error);
  }
  const unavailableModels: string[] = [];
  for (const id of new Set(opts.models ?? [])) {
    try {
      await client.models.retrieve(id);
    } catch (error) {
      if ((error as { status?: unknown })?.status === 404) unavailableModels.push(id);
      else return failureOf(error);
    }
  }
  return { ok: true, unavailableModels };
}
