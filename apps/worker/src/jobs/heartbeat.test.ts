import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { HEARTBEAT_KEY, writeHeartbeat } from './heartbeat.js';

describe('heartbeat job', () => {
  let testDb: TestDb;
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const created = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = created.db;
    end = () => created.pool.end();
  });

  afterAll(async () => {
    await end?.();
    await testDb?.drop();
  });

  async function readRow() {
    const rows = await db
      .select()
      .from(schema.systemStatus)
      .where(eq(schema.systemStatus.key, HEARTBEAT_KEY));
    return rows[0];
  }

  it('writes system_status with an ISO timestamp from the last minute', async () => {
    const before = Date.now();
    await writeHeartbeat(db);
    const row = await readRow();
    const at = (row?.value as { at: string }).at;
    expect(at).toBe(new Date(at).toISOString());
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.now() - Date.parse(at)).toBeLessThan(60_000);
  });

  it('overwrites the single row on every run', async () => {
    await writeHeartbeat(db, new Date('2026-01-01T00:00:00.000Z'));
    await writeHeartbeat(db, new Date('2026-01-01T00:05:00.000Z'));
    const rows = await db
      .select()
      .from(schema.systemStatus)
      .where(eq(schema.systemStatus.key, HEARTBEAT_KEY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ at: '2026-01-01T00:05:00.000Z' });
  });
});
