import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../packages/db/test/pg.js';

const TEST_KEY = '0123456789abcdef'.repeat(4);
const cwd = fileURLToPath(new URL('..', import.meta.url));

function runWorker(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('worker process startup failures', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it('exits non-zero when the health port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const { code, out } = await runWorker({
        DATABASE_URL: testDb.appUrl(APP_PASSWORD),
        ENCRYPTION_KEY: TEST_KEY,
        WORKER_HEALTH_PORT: String(port),
      });
      expect(code).toBe(1);
      expect(out).toContain('startup failed');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('exits non-zero when the database is unreachable', async () => {
    const { code, out } = await runWorker({
      DATABASE_URL: 'postgres://pfm_app:x@127.0.0.1:1/pfm',
      ENCRYPTION_KEY: TEST_KEY,
      WORKER_HEALTH_PORT: '0',
    });
    expect(code).toBe(1);
    expect(out).toContain('startup failed');
  });
});

describe('worker readiness during the startup backfill', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, r));
    const port = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    return port;
  }

  it('serves /healthz while a slow backfill is still running, and finishes the backfill after', async () => {
    const owner = createDb(testDb.ownerUrl, { max: 2 });
    await owner.db.insert(schema.organization).values({
      id: 'hh-slow',
      name: 'Slow',
      slug: 'hh-slow',
      createdAt: new Date(),
    });
    // Blocks the backfill's read of category_group until released.
    const blocker = await owner.pool.connect();
    await blocker.query('begin');
    await blocker.query('lock table category_group in access exclusive mode');

    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: testDb.appUrl(APP_PASSWORD),
        ENCRYPTION_KEY: TEST_KEY,
        WORKER_HEALTH_PORT: String(port),
      },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    const exited = new Promise((r) => child.on('close', r));
    try {
      let status = 0;
      for (let i = 0; i < 32 && status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 250));
        status = await fetch(`http://127.0.0.1:${port}/healthz`)
          .then((res) => res.status)
          .catch(() => 0);
      }
      expect(status).toBe(200);
      expect(out).not.toContain('seeded default categories');

      await blocker.query('commit');
      for (let i = 0; i < 40 && !out.includes('seeded default categories'); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(out).toContain('seeded default categories for 1 household(s)');
    } finally {
      blocker.release();
      child.kill('SIGTERM');
      await exited;
      await owner.pool.end();
    }
  });
});
