import { describe, expect, it, vi } from 'vitest';
import { SseParser, streamAdvisorMessage, type AdvisorStreamEvent } from './use-advisor-stream';

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const proposal = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'budget_line_amount',
  payload: { kind: 'budget_line_amount', monthlyAmount: '250.00', reason: 'Above your usual' },
  basis: { months: 3, min: 20000, max: 30000, median: 25000, currency: 'EUR' },
  status: 'pending',
  createdAt: '2026-11-24T10:00:00.000Z',
};

async function run(fetcher: typeof fetch) {
  const events: AdvisorStreamEvent[] = [];
  const outcome = await streamAdvisorMessage('How is this month going?', {
    onEvent: (e) => events.push(e),
    fetcher,
  });
  return { events, outcome };
}

describe('streamAdvisorMessage', () => {
  it('turns an SSE answer into text, tool and proposal events, then done', async () => {
    const body =
      frame('tool', { name: 'get_budget_vs_actual' }) +
      frame('text', { delta: 'Dining is ' }) +
      frame('text', { delta: 'above your usual range.' }) +
      frame('proposal', { proposal }) +
      frame('done', { messageId: 'm-1' });
    const { events, outcome } = await run(async () => sseResponse([body]));
    expect(events).toEqual([
      { type: 'tool', name: 'get_budget_vs_actual' },
      { type: 'text', delta: 'Dining is ' },
      { type: 'text', delta: 'above your usual range.' },
      {
        type: 'proposal',
        proposal: {
          id: proposal.id,
          kind: 'budget_line_amount',
          payload: proposal.payload,
          basis: proposal.basis,
          status: 'pending',
        },
      },
    ]);
    expect(outcome).toEqual({ status: 'done', messageId: 'm-1' });
  });

  it('reassembles a frame that arrives over several chunks', async () => {
    const whole = frame('text', { delta: 'héllo' }) + frame('done', { messageId: 'm-2' });
    const cut = whole.indexOf('llo');
    const { events, outcome } = await run(async () =>
      sseResponse([whole.slice(0, cut), whole.slice(cut)]),
    );
    expect(events).toEqual([{ type: 'text', delta: 'héllo' }]);
    expect(outcome).toEqual({ status: 'done', messageId: 'm-2' });
  });

  it('posts the text as JSON', async () => {
    const fetcher = vi.fn(async () => sseResponse([frame('done', { messageId: 'm' })]));
    await run(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/advisor/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'How is this month going?' }),
      }),
    );
  });

  it.each([
    [429, 'daily_limit'],
    [409, 'busy'],
    [403, 'ai_off'],
    [503, 'not_configured'],
    [401, 'unavailable'],
    [500, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const { events, outcome } = await run(
      async () => new Response(JSON.stringify({ error: 'x' }), { status }),
    );
    expect(events).toEqual([]);
    expect(outcome).toEqual({ status: 'failed', code });
  });

  it('reports an error event as unavailable and keeps what streamed before it', async () => {
    const { events, outcome } = await run(async () =>
      sseResponse([frame('text', { delta: 'Part' }), frame('error', { code: 'unavailable' })]),
    );
    expect(events).toEqual([{ type: 'text', delta: 'Part' }]);
    expect(outcome).toEqual({ status: 'failed', code: 'unavailable' });
  });

  it('reports a stream that ends without done, and a network failure, as unavailable', async () => {
    const cut = await run(async () => sseResponse([frame('text', { delta: 'Part' })]));
    expect(cut.outcome).toEqual({ status: 'failed', code: 'unavailable' });
    const offline = await run(async () => {
      throw new TypeError('network down');
    });
    expect(offline.outcome).toEqual({ status: 'failed', code: 'unavailable' });
  });

  it('reports an aborted request as aborted, not as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await streamAdvisorMessage('hi', {
      signal: controller.signal,
      onEvent: () => {},
      fetcher: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    expect(outcome).toEqual({ status: 'aborted' });
  });
});

describe('SseParser', () => {
  it('ignores comments, frames without data and frames that are not JSON', () => {
    const parser = new SseParser();
    expect(parser.feed(': keep-alive\n\nevent: x\n\nevent: text\ndata: {oops\n\n')).toEqual([]);
    expect(parser.feed('event: text\r\ndata: {"delta":"a"}\r\n\r\n')).toEqual([
      { event: 'text', data: { delta: 'a' } },
    ]);
  });
});
