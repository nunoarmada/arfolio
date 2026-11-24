import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdvisorClient } from '../src/advisor/client.js';

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('advisor client', () => {
  let server: Server;
  let baseURL: string;
  let requests = 0;
  let mode: 'ok' | 'hang' = 'ok';
  let lastBody: Record<string, unknown> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests += 1;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'hang') return;
        res.write(
          sse('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'm',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
        );
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );
        for (const piece of ['Hel', 'lo']) {
          res.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: piece },
            }),
          );
        }
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          }),
        );
        res.end(sse('message_stop', { type: 'message_stop' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const params = {
    model: 'm',
    max_tokens: 10,
    messages: [{ role: 'user' as const, content: 'hi' }],
    stream: true as const,
  };

  it('streams text deltas and resolves with the full message', async () => {
    mode = 'ok';
    const deltas: string[] = [];
    const message = await createAdvisorClient('sk-ant-e2e-fake-key-1', { baseURL }).stream(
      params,
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(message.content).toMatchObject([{ type: 'text', text: 'Hello' }]);
    expect(message.stop_reason).toBe('end_turn');
    expect(lastBody.stream).toBe(true);
  });

  it('stops when the signal aborts and does not retry', async () => {
    mode = 'hang';
    requests = 0;
    const controller = new AbortController();
    const call = createAdvisorClient('sk-ant-e2e-fake-key-1', { baseURL }).stream(
      params,
      () => {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(call).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
