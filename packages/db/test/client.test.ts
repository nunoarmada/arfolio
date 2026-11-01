import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

describe('createDb pool resilience', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it('survives an idle client being terminated and serves the next query', async () => {
    const onError = vi.fn();
    const { pool } = createDb(testDb.appUrl(APP_PASSWORD), { max: 1, onError });
    try {
      const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      const errored = new Promise<void>((resolve) => pool.once('error', () => resolve()));

      const admin = new pg.Client({ connectionString: testDb.ownerUrl });
      await admin.connect();
      try {
        await admin.query('select pg_terminate_backend($1)', [rows[0]!.pid]);
      } finally {
        await admin.end();
      }
      await errored;

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatch(/terminat/i);
      const next = await pool.query('select 1 as one');
      expect(next.rows[0]).toEqual({ one: 1 });
    } finally {
      await pool.end();
    }
  });

  it('applies a statement timeout when asked to', async () => {
    const { pool } = createDb(testDb.appUrl(APP_PASSWORD), { max: 1, statementTimeoutMs: 100 });
    try {
      await expect(pool.query('select pg_sleep(5)')).rejects.toThrow(/statement timeout/i);
      await expect(pool.query('select 1 as one')).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });
});
