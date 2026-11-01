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

describe('asset disposal schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let accountId: string;
  let seq = 0;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values({ id: 'hA', name: 'hA', slug: 'hA', createdAt: new Date() });
    const [account] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.financialAccount)
        .values({ householdId: 'hA', name: 'Main', type: 'checking' })
        .returning({ id: schema.financialAccount.id }),
    );
    accountId = account!.id;
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

  const newTransaction = async () => {
    const n = ++seq;
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.transaction)
        .values({
          householdId: 'hA',
          accountId,
          dedupeHash: `sale-${n}`,
          bookingDate: '2026-10-01',
          amount: 5000,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'SALE',
          source: 'manual',
        })
        .returning({ id: schema.transaction.id }),
    );
    return row!.id;
  };

  it('exposes the disposal kinds', () => {
    expect(schema.DISPOSAL_KINDS).toEqual(['sold', 'written_off']);
  });

  it('rejects disposal_kind without disposed_on, and the reverse', async () => {
    expect(await pgError(newAsset({ disposalKind: 'sold' }))).toContain('asset_disposal_check');
    expect(await pgError(newAsset({ disposedOn: '2026-10-01' }))).toContain('asset_disposal_check');
  });

  it('rejects an unknown disposal_kind', async () => {
    const message = await pgError(
      newAsset({ disposedOn: '2026-10-01', disposalKind: 'lost' as 'sold' }),
    );
    expect(message).toContain('asset_disposal_kind_check');
  });

  it('rejects sale_amount or sale_transaction_id on a written_off asset', async () => {
    const base = { disposedOn: '2026-10-01', disposalKind: 'written_off' as const };
    expect(await pgError(newAsset({ ...base, saleAmount: 100 }))).toContain('asset_sale_check');
    const txId = await newTransaction();
    expect(await pgError(newAsset({ ...base, saleTransactionId: txId }))).toContain(
      'asset_sale_check',
    );
  });

  it('rejects sale_amount or sale_transaction_id on a live asset', async () => {
    expect(await pgError(newAsset({ saleAmount: 100 }))).toContain('asset_sale_check');
    const txId = await newTransaction();
    expect(await pgError(newAsset({ saleTransactionId: txId }))).toContain('asset_sale_check');
  });

  it('rejects a negative sale_amount', async () => {
    const message = await pgError(
      newAsset({ disposedOn: '2026-10-01', disposalKind: 'sold', saleAmount: -1 }),
    );
    expect(message).toContain('asset_sale_amount_check');
  });

  it('stores a sold asset and a written-off asset', async () => {
    const txId = await newTransaction();
    const [sold] = await newAsset({
      disposedOn: '2026-10-01',
      disposalKind: 'sold',
      saleAmount: 5000,
      saleTransactionId: txId,
    });
    const [off] = await newAsset({ disposedOn: '2026-10-02', disposalKind: 'written_off' });
    const rows = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.asset).where(eq(schema.asset.id, sold!.id)),
    );
    expect(rows[0]).toMatchObject({
      disposedOn: '2026-10-01',
      disposalKind: 'sold',
      saleAmount: 5000,
      saleTransactionId: txId,
    });
    expect(off!.id).toBeTruthy();
  });

  it('sale_transaction_id is unique when set', async () => {
    const txId = await newTransaction();
    const sold = { disposedOn: '2026-10-01', disposalKind: 'sold' as const };
    await newAsset({ ...sold, saleTransactionId: txId });
    const message = await pgError(newAsset({ ...sold, saleTransactionId: txId }));
    expect(message).toContain('asset_sale_transaction_unique');
    // Null is not unique-constrained.
    await newAsset(sold);
    await newAsset(sold);
  });

  it('deleting the sale transaction nulls only sale_transaction_id', async () => {
    const txId = await newTransaction();
    const [sold] = await newAsset({
      disposedOn: '2026-10-03',
      disposalKind: 'sold',
      saleAmount: 700,
      saleTransactionId: txId,
    });
    await withHousehold(db, 'hA', (tx) =>
      tx.delete(schema.transaction).where(eq(schema.transaction.id, txId)),
    );
    const [row] = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(schema.asset).where(eq(schema.asset.id, sold!.id)),
    );
    expect(row).toMatchObject({
      householdId: 'hA',
      disposedOn: '2026-10-03',
      disposalKind: 'sold',
      saleAmount: 700,
      saleTransactionId: null,
    });
  });

  it('stores settled_on on a liability, null by default', async () => {
    const [plain] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.liability)
        .values({ householdId: 'hA', kind: 'loan', name: 'Loan', currency: 'EUR' })
        .returning(),
    );
    expect(plain!.settledOn).toBeNull();
    const [settled] = await withHousehold(db, 'hA', (tx) =>
      tx
        .insert(schema.liability)
        .values({
          householdId: 'hA',
          kind: 'loan',
          name: 'Loan 2',
          currency: 'EUR',
          settledOn: '2026-10-05',
        })
        .returning(),
    );
    expect(settled!.settledOn).toBe('2026-10-05');
  });
});
