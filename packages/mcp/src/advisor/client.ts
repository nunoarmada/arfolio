import Anthropic from '@anthropic-ai/sdk';

/** One streamed model call: text deltas go to `onText` as they arrive, the full message is returned. */
export type AdvisorModelClient = {
  stream(
    params: Anthropic.MessageCreateParamsStreaming,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message>;
};

const TIMEOUT_MS = 120_000;

/**
 * The Anthropic SDK behind {@link AdvisorModelClient}. No retries: the member is waiting and a
 * retried stream could repeat text the browser already shows. `baseURL` omitted means the SDK
 * default, which already honours `ANTHROPIC_BASE_URL`.
 */
export function createAdvisorClient(
  apiKey: string,
  opts: { baseURL?: string } = {},
): AdvisorModelClient {
  const anthropic = new Anthropic({
    apiKey,
    timeout: TIMEOUT_MS,
    maxRetries: 0,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  return {
    async stream(params, onText, signal) {
      const stream = anthropic.messages.stream(params, signal ? { signal } : undefined);
      stream.on('text', (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}
