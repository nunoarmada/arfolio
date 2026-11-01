import { createServer, type Server } from 'node:http';

/** Resolves true when the worker can do its job (boss started, DB reachable); never rejects. */
export type ReadinessCheck = () => Promise<boolean>;

/** `GET /healthz` -> 200 {"status":"ok"} when ready, else 503. Everything else is 404. */
export function createHealthServer(isReady: ReadinessCheck): Server {
  return createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (req.method !== 'GET' || path !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    isReady().then(
      (ok) => respond(ok),
      () => respond(false),
    );
    function respond(ok: boolean): void {
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' }));
    }
  });
}
