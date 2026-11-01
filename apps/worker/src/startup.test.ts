import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../packages/db/test/pg.js';
import { runStartupBackfill } from './startup.js';

describe('startup backfill', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    const own = createDb(testDb.ownerUrl, { max: 1 });
    db = app.db;
    owner = own.db;
    end = async () => {
      await app.pool.end();
      await own.pool.end();
    };
  });

  afterAll(async () => {
    await end?.();
    await testDb?.drop();
  });

  const groupNames = (householdId: string) =>
    withHousehold(db, householdId, async (tx) =>
      (await tx.select({ name: schema.categoryGroup.name }).from(schema.categoryGroup)).map(
        (g) => g.name,
      ),
    );

  it('seeds households without categories in their locale, and is idempotent', async () => {
    await owner.insert(schema.organization).values({
      id: 'hh-pt',
      name: 'PT',
      slug: 'hh-pt',
      createdAt: new Date(),
    });
    await withHousehold(db, 'hh-pt', (tx) =>
      tx.insert(schema.householdSettings).values({ householdId: 'hh-pt', locale: 'pt-PT' }),
    );

    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await runStartupBackfill(db)).toBe(1);
      expect(String(stdout.mock.calls[0]?.[0])).toContain('seeded default categories for 1');
      expect(await runStartupBackfill(db)).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    expect(await groupNames('hh-pt')).toContain('Receitas');
    expect(await groupNames('hh-pt')).toHaveLength(10);
  });

  it('never throws: a failing backfill is reported as zero households', async () => {
    const broken = {
      select: () => {
        throw new Error('db down');
      },
    } as unknown as Db;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(runStartupBackfill(broken)).resolves.toBe(0);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('backfill failed: db down');
    } finally {
      stderr.mockRestore();
    }
  });
});
