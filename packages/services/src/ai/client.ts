import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './categorise.js';

/**
 * Builds the SDK client for a request that runs inside the web app (the worker has its own
 * factory). `baseURL` omitted means the SDK default, which already honours `ANTHROPIC_BASE_URL`.
 * No retries by default: the person is waiting, and a failed extraction is cheap to run again.
 */
export function createAnthropicClient(
  apiKey: string,
  opts: { timeoutMs?: number; maxRetries?: number; baseURL?: string } = {},
): AnthropicLike {
  return new Anthropic({
    apiKey,
    timeout: opts.timeoutMs ?? 120_000,
    maxRetries: opts.maxRetries ?? 0,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
}
