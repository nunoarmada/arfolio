import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

describe('pg-boss schema installed by runMigrations', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it('lets pfm_app run pg-boss without any DDL (migrate: false) and exchange a job', async () => {
    const boss = new PgBoss({
      connectionString: testDb.appUrl(APP_PASSWORD),
      migrate: false,
      createSchema: false,
    });
    boss.on('error', () => {});
    await boss.start();
    try {
      await boss.createQueue('probe');
      const id = await boss.send('probe', { n: 1 });
      expect(id).toEqual(expect.any(String));
      const jobs = await boss.fetch<{ n: number }>('probe');
      expect(jobs.map((j) => j.data)).toEqual([{ n: 1 }]);
      await boss.complete(
        'probe',
        jobs.map((j) => j.id),
      );
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('keeps working after a second runMigrations (idempotent install)', async () => {
    await runMigrations(testDb.ownerUrl, APP_PASSWORD);
    const owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query(`select 1 from pg_namespace where nspname = 'pgboss'`);
      expect(rows).toHaveLength(1);
    } finally {
      await owner.end();
    }
  });
});
