import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { QUEUES } from '../queues.js';
import { CONSENT_CHECK_CRON, registerConsentCheck } from './consent-check.js';

vi.mock('../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  errorMessage: () => 'error',
}));

describe('consent-check job', () => {
  let testDb: TestDb;
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    end = () => app.pool.end();
  });
  afterAll(async () => {
    await end();
    await testDb?.drop();
  });

  it('schedules the daily run and queues push delivery after each pass', async () => {
    const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
    let cron = '';
    const boss = {
      createQueue: async () => {},
      work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) =>
        void handlers.set(n, h),
      schedule: async (_n: string, c: string) => {
        cron = c;
      },
    } as unknown as PgBoss;
    const afterNotify = vi.fn(async () => {});

    await registerConsentCheck(boss, db, 'UTC', afterNotify);
    await handlers.get(QUEUES.consentCheck)!([{}]);

    expect(cron).toBe(CONSENT_CHECK_CRON);
    expect(afterNotify).toHaveBeenCalledTimes(1);
  });
});
