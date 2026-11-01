import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  }
  throw new Error('expected the query to be rejected');
}

describe('AI asset valuation schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values({ id: 'hA', name: 'hA', slug: 'hA', createdAt: new Date() });
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  const newAsset = (extra: Partial<typeof schema.asset.$inferInsert>) =>
    withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.asset)
        .values({ householdId: 'hA', kind: 'other', name: 'Thing', currency: 'EUR', ...extra })
        .returning({ id: schema.asset.id }),
    );

  it('rejects an AI-valued asset that also depreciates', async () => {
    const message = await pgError(newAsset({ aiValuation: true, depreciationBpsPerYear: 1500 }));
    expect(message).toContain('asset_ai_depreciation_check');
  });

  it('stores details and AI state on an asset, with AI off by default', async () => {
    const [plain] = await newAsset({ name: 'Plain' });
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.asset).where(eq(schema.asset.id, plain!.id)),
    );
    expect(row).toMatchObject({ aiValuation: false, details: null, aiRequestedAt: null });
    const [ai] = await newAsset({ aiValuation: true, details: { rooms: 3 } });
    expect(ai!.id).toBeTruthy();
  });

  it('accepts an ai valuation with an estimate and rejects an unknown method', async () => {
    const [{ id: assetId }] = (await newAsset({ name: 'Flat' })) as [{ id: string }];
    const estimate = {
      low: 100,
      high: 200,
      confidence: 'medium' as const,
      sources: [{ title: 'Listing', url: 'https://example.com/a' }],
    };
    await withHousehold(db, 'hA', (tx) =>
      tx.insert(schema.assetValuation).values({
        householdId: 'hA',
        assetId,
        asOf: '2026-10-31',
        value: 150,
        method: 'ai',
        estimate,
      }),
    );
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.assetValuation).where(eq(schema.assetValuation.assetId, assetId)),
    );
    expect(row!.estimate).toEqual(estimate);
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.assetValuation).values({
          householdId: 'hA',
          assetId,
          asOf: '2026-11-01',
          value: 1,
          method: 'guess' as never,
        }),
      ),
    );
    expect(message).toContain('asset_valuation_method_check');
  });
});
