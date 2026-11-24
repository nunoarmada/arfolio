'use client';

import { useCallback, useEffect, useRef } from 'react';
import { toChatProposal, type ChatProposal } from './advisor-types';

/** Why a turn did not produce an answer. */
export type AdvisorErrorCode = 'ai_off' | 'busy' | 'daily_limit' | 'not_configured' | 'unavailable';

/** What the server streams while it answers, in the order it happens. */
export type AdvisorStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: ChatProposal };

export type AdvisorStreamOutcome =
  | { status: 'done'; messageId: string | null }
  | { status: 'failed'; code: AdvisorErrorCode }
  | { status: 'aborted' };

const HTTP_CODES: Record<number, AdvisorErrorCode> = {
  403: 'ai_off',
  409: 'busy',
  429: 'daily_limit',
  503: 'not_configured',
};

type Frame = { event: string; data: unknown };

/** Splits an SSE byte stream into frames; a frame may arrive over several chunks. */
export class SseParser {
  private buffer = '';

  feed(chunk: string): Frame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const frames: Frame[] = [];
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = parseFrame(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
      if (frame) frames.push(frame);
      end = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

function parseFrame(raw: string): Frame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    // A frame that is not JSON is not one of ours: skipped rather than breaking the answer.
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Maps one frame to a UI event, or to the end of the turn. */
function readFrame(frame: Frame): AdvisorStreamEvent | AdvisorStreamOutcome | null {
  const data = isRecord(frame.data) ? frame.data : {};
  switch (frame.event) {
    case 'text':
      return typeof data.delta === 'string' ? { type: 'text', delta: data.delta } : null;
    case 'tool':
      return typeof data.name === 'string' ? { type: 'tool', name: data.name } : null;
    case 'proposal': {
      const p = data.proposal;
      if (!isRecord(p) || typeof p.id !== 'string' || typeof p.kind !== 'string') return null;
      return {
        type: 'proposal',
        proposal: toChatProposal({
          id: p.id,
          kind: p.kind,
          payload: p.payload,
          basis: p.basis,
          status: typeof p.status === 'string' ? p.status : 'pending',
        }),
      };
    }
    case 'done':
      return {
        status: 'done',
        messageId: typeof data.messageId === 'string' ? data.messageId : null,
      };
    case 'error':
      return { status: 'failed', code: 'unavailable' };
    default:
      return null;
  }
}

const isOutcome = (
  value: AdvisorStreamEvent | AdvisorStreamOutcome,
): value is AdvisorStreamOutcome => 'status' in value;

/**
 * Posts one message and reads the answer as it streams. HTTP refusals come back as codes (429
 * `daily_limit`, 409 `busy`, 403 `ai_off`, 503 `not_configured`); a dropped connection, an
 * `error` event or a stream that ends without `done` is `unavailable`. Nothing is thrown.
 */
export async function streamAdvisorMessage(
  text: string,
  opts: {
    signal?: AbortSignal;
    onEvent: (event: AdvisorStreamEvent) => void;
    fetcher?: typeof fetch;
  },
): Promise<AdvisorStreamOutcome> {
  const fetcher = opts.fetcher ?? fetch;
  try {
    const response = await fetcher('/api/advisor/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok || !response.body) {
      return { status: 'failed', code: HTTP_CODES[response.status] ?? 'unavailable' };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
        const item = readFrame(frame);
        if (!item) continue;
        if (isOutcome(item)) return item;
        opts.onEvent(item);
      }
    }
    return { status: 'failed', code: 'unavailable' };
  } catch (error) {
    if (opts.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { status: 'aborted' };
    }
    return { status: 'failed', code: 'unavailable' };
  }
}

/** The stream bound to a component: one turn at a time, aborted when the component goes away. */
export function useAdvisorStream(): {
  send: (
    text: string,
    onEvent: (event: AdvisorStreamEvent) => void,
  ) => Promise<AdvisorStreamOutcome>;
  abort: () => void;
} {
  const controller = useRef<AbortController | null>(null);
  const abort = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);
  useEffect(() => abort, [abort]);
  const send = useCallback(
    async (text: string, onEvent: (event: AdvisorStreamEvent) => void) => {
      abort();
      const own = new AbortController();
      controller.current = own;
      try {
        return await streamAdvisorMessage(text, { signal: own.signal, onEvent });
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [abort],
  );
  return { send, abort };
}
