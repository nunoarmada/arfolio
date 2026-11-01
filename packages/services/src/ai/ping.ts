import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';

export type AnthropicPingResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_key' | 'rate_limited' | 'unreachable' | 'unavailable' };

const PING_TIMEOUT_MS = 10_000;

/**
 * Checks an Anthropic API key with the cheapest call the API offers: listing one model. It sends
 * no user data, uses no tokens and never retries. The result carries a fixed reason, never the
 * SDK's error text, because that text can quote the key.
 */
export async function pingAnthropic(
  apiKey: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<AnthropicPingResult> {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: PING_TIMEOUT_MS,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  try {
    await client.models.list({ limit: 1 });
    return { ok: true };
  } catch (error) {
    if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
      return { ok: false, reason: 'unreachable' };
    }
    const status = (error as { status?: unknown })?.status;
    if (status === 401 || status === 403) return { ok: false, reason: 'invalid_key' };
    if (status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'unavailable' };
  }
}
