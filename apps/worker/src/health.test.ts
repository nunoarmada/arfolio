import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthServer } from './health.js';

describe('health server', () => {
  const servers: ReturnType<typeof createHealthServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function get(ready: () => Promise<boolean>, path = '/healthz', method = 'GET') {
    const server = createHealthServer(ready);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}${path}`, { method });
  }

  it('answers 200 when ready', async () => {
    const res = await get(async () => true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 when not ready', async () => {
    expect((await get(async () => false)).status).toBe(503);
  });

  it('answers 503 when the readiness check throws', async () => {
    expect((await get(() => Promise.reject(new Error('db down')))).status).toBe(503);
  });

  it('answers 404 for other paths and methods', async () => {
    expect((await get(async () => true, '/')).status).toBe(404);
    expect((await get(async () => true, '/healthz', 'POST')).status).toBe(404);
  });
});
