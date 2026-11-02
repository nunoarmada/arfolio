import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../packages/db/test/pg.js';
import { runStartupBackfill, runStartupTransferRepair } from './startup.js';

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

  it('links late transfer legs on start, once, and never throws', async () => {
    const householdId = 'hh-transfer';
    await owner.insert(schema.organization).values({
      id: householdId,
      name: 'T',
      slug: householdId,
      createdAt: new Date(),
    });
    await withHousehold(db, householdId, (tx) =>
      tx.insert(schema.householdSettings).values({ householdId, locale: 'en' }),
    );
    const [from, to] = await owner
      .insert(schema.financialAccount)
      .values(
        ['From', 'To'].map((name) => ({
          householdId,
          name,
          type: 'checking' as const,
          currency: 'EUR',
        })),
      )
      .returning({ id: schema.financialAccount.id });
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    await owner.insert(schema.transaction).values(
      [
        { accountId: from!.id, amount: -4_200, bookingDate: day(5) },
        { accountId: to!.id, amount: 4_200, bookingDate: day(3) },
      ].map((x, i) => ({
        ...x,
        householdId,
        currency: 'EUR',
        status: 'booked' as const,
        rawDescription: 'raw',
        dedupeHash: `startup-${i}`,
        source: 'connector' as const,
      })),
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await runStartupTransferRepair(db)).toBe(1);
      expect(await runStartupTransferRepair(db)).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    const groups = await owner
      .select({ g: schema.transaction.transferGroupId })
      .from(schema.transaction)
      .where(eq(schema.transaction.householdId, householdId));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.g).not.toBeNull();
    expect(groups[0]!.g).toBe(groups[1]!.g);

    const broken = {
      select: () => {
        throw new Error('db down');
      },
    } as unknown as Db;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(runStartupTransferRepair(broken)).resolves.toBe(0);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('transfer repair failed: db down');
    } finally {
      stderr.mockRestore();
    }
  });
});
