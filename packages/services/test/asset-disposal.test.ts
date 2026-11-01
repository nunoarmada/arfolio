import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  addAssetValuation,
  archiveAsset,
  claimDueAssetValuations,
  createAccount,
  createAsset,
  createLiability,
  deleteAsset,
  disposeAsset,
  ForbiddenError,
  householdToday,
  listAssets,
  listLiabilities,
  listSaleCandidates,
  settleLiability,
  undoAssetDisposal,
  updateAsset,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { asset, assetValuation, liability, transaction } = schema;

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).code;
  }
  throw new Error('expected a ValidationError');
};

describe('asset disposal', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function addTx(
    ctx: ServiceCtx,
    accountId: string,
    over: Partial<typeof transaction.$inferInsert> = {},
  ) {
    const [row] = await t.owner
      .insert(transaction)
      .values({
        householdId: ctx.householdId,
        accountId,
        dedupeHash: `h-${Math.random()}`,
        bookingDate: '2026-03-12',
        amount: 20_000_00,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'TRF CAR SALE',
        source: 'manual',
        ...over,
      })
      .returning();
    return row!;
  }

  async function setup() {
    const ctx = await t.household();
    const account = await createAccount(ctx, { name: 'Current', type: 'checking' });
    const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
    return { ctx, account, car };
  }

  const tomorrowOf = async (ctx: ServiceCtx) => {
    const { today } = await householdToday(ctx);
    return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  };

  it('sells by hand', async () => {
    const { ctx, car } = await setup();
    const sold = await disposeAsset(ctx, car.id, {
      kind: 'sold',
      date: '2026-03-10',
      amount: 15_000_00,
    });
    expect(sold).toMatchObject({
      disposedOn: '2026-03-10',
      disposalKind: 'sold',
      saleAmount: 15_000_00,
      saleTransactionId: null,
    });
  });

  it('sells from a transaction', async () => {
    const { ctx, account, car } = await setup();
    const tx = await addTx(ctx, account.id);
    const sold = await disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id });
    expect(sold).toMatchObject({
      disposedOn: '2026-03-12',
      saleAmount: 20_000_00,
      saleTransactionId: tx.id,
    });
  });

  it('refuses a typed date or amount next to a transaction', async () => {
    const { ctx, account, car } = await setup();
    const tx = await addTx(ctx, account.id);
    await expect(
      disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id, amount: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id, date: '2026-03-12' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('needs an amount and a date or a transaction to sell', async () => {
    const { ctx, car } = await setup();
    expect(await codeOf(disposeAsset(ctx, car.id, { kind: 'sold', date: '2026-03-10' }))).toBe(
      'sale_needs_amount',
    );
    expect(await codeOf(disposeAsset(ctx, car.id, { kind: 'sold', amount: 5 }))).toBe(
      'sale_needs_amount',
    );
  });

  it('refuses pending, negative, transfer, other-currency and other-household transactions', async () => {
    const { ctx, account, car } = await setup();
    const other = await t.household();
    const otherAccount = await createAccount(other, { name: 'Theirs', type: 'checking' });
    const usd = await createAccount(ctx, { name: 'Dollars', type: 'checking', currency: 'USD' });
    const bad = [
      await addTx(ctx, account.id, { status: 'pending' }),
      await addTx(ctx, account.id, { amount: -500 }),
      await addTx(ctx, account.id, { transferGroupId: crypto.randomUUID() }),
      await addTx(ctx, usd.id, { currency: 'USD' }),
      await addTx(other, otherAccount.id),
    ];
    for (const tx of bad) {
      expect(await codeOf(disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id }))).toBe(
        'sale_transaction_invalid',
      );
    }
    expect(
      await codeOf(disposeAsset(ctx, car.id, { kind: 'sold', transactionId: crypto.randomUUID() })),
    ).toBe('sale_transaction_invalid');
  });

  it('refuses a transaction another asset was sold with', async () => {
    const { ctx, account, car } = await setup();
    const boat = await createAsset(ctx, { kind: 'vehicle', name: 'Boat' });
    const tx = await addTx(ctx, account.id);
    await disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id });
    expect(await codeOf(disposeAsset(ctx, boat.id, { kind: 'sold', transactionId: tx.id }))).toBe(
      'sale_transaction_taken',
    );
  });

  it('writes off with a date and refuses an amount', async () => {
    const { ctx, car } = await setup();
    await expect(
      disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10', amount: 5 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(disposeAsset(ctx, car.id, { kind: 'written_off' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const written = await disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10' });
    expect(written).toMatchObject({
      disposedOn: '2026-03-10',
      disposalKind: 'written_off',
      saleAmount: null,
      saleTransactionId: null,
    });
  });

  it('refuses future dates', async () => {
    const { ctx, car } = await setup();
    const tomorrow = await tomorrowOf(ctx);
    expect(await codeOf(disposeAsset(ctx, car.id, { kind: 'written_off', date: tomorrow }))).toBe(
      'date_in_future',
    );
    expect(
      await codeOf(disposeAsset(ctx, car.id, { kind: 'sold', date: tomorrow, amount: 1 })),
    ).toBe('date_in_future');
  });

  it('refuses an already disposed asset', async () => {
    const { ctx, car } = await setup();
    await disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10' });
    expect(
      await codeOf(disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-11' })),
    ).toBe('asset_already_disposed');
  });

  it('refuses an archived asset', async () => {
    const { ctx, car } = await setup();
    await archiveAsset(ctx, car.id);
    expect(
      await codeOf(disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10' })),
    ).toBe('asset_archived');
  });

  it('maps a race on the sale transaction to sale_transaction_taken', async () => {
    const { ctx, account, car } = await setup();
    const boat = await createAsset(ctx, { kind: 'vehicle', name: 'Boat' });
    const tx = await addTx(ctx, account.id);
    const results = await Promise.allSettled([
      disposeAsset(ctx, car.id, { kind: 'sold', transactionId: tx.id }),
      disposeAsset(ctx, boat.id, { kind: 'sold', transactionId: tx.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ValidationError);
    expect((lost.reason as ValidationError).code).toBe('sale_transaction_taken');
  });

  it('settles chosen linked liabilities in the same transaction', async () => {
    const { ctx, car } = await setup();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Car loan', assetId: car.id });
    await disposeAsset(ctx, car.id, {
      kind: 'sold',
      date: '2026-03-10',
      amount: 9_000_00,
      settle: [{ liabilityId: loan.id, date: '2026-03-10' }],
    });
    const [row] = await t.owner.select().from(liability).where(eq(liability.id, loan.id));
    expect(row!.settledOn).toBe('2026-03-10');
    expect((await listLiabilities(ctx)).map((l) => l.id)).not.toContain(loan.id);
  });

  it('rolls everything back when a liability to settle is not linked', async () => {
    const { ctx, car } = await setup();
    const linked = await createLiability(ctx, { kind: 'loan', name: 'Linked', assetId: car.id });
    const stranger = await createLiability(ctx, { kind: 'loan', name: 'Stranger' });
    const code = await codeOf(
      disposeAsset(ctx, car.id, {
        kind: 'written_off',
        date: '2026-03-10',
        settle: [
          { liabilityId: linked.id, date: '2026-03-10' },
          { liabilityId: stranger.id, date: '2026-03-10' },
        ],
      }),
    );
    expect(code).toBe('liability_not_linked');
    const [a] = await t.owner.select().from(asset).where(eq(asset.id, car.id));
    expect(a).toMatchObject({ disposedOn: null, disposalKind: null });
    const [l] = await t.owner.select().from(liability).where(eq(liability.id, linked.id));
    expect(l!.settledOn).toBeNull();
  });

  it('refuses to settle a liability that is already settled', async () => {
    const { ctx, car } = await setup();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', assetId: car.id });
    await settleLiability(ctx, loan.id, { date: '2026-03-01' });
    expect(
      await codeOf(
        disposeAsset(ctx, car.id, {
          kind: 'written_off',
          date: '2026-03-10',
          settle: [{ liabilityId: loan.id, date: '2026-03-10' }],
        }),
      ),
    ).toBe('liability_already_settled');
  });

  it('undo clears the four columns and leaves liabilities settled', async () => {
    const { ctx, account, car } = await setup();
    const tx = await addTx(ctx, account.id);
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', assetId: car.id });
    await disposeAsset(ctx, car.id, {
      kind: 'sold',
      transactionId: tx.id,
      settle: [{ liabilityId: loan.id, date: '2026-03-12' }],
    });
    const back = await undoAssetDisposal(ctx, car.id);
    expect(back).toMatchObject({
      disposedOn: null,
      disposalKind: null,
      saleAmount: null,
      saleTransactionId: null,
    });
    const [l] = await t.owner.select().from(liability).where(eq(liability.id, loan.id));
    expect(l!.settledOn).toBe('2026-03-12');
    expect(await codeOf(undoAssetDisposal(ctx, car.id))).toBe('asset_not_disposed');
  });

  it('undo refuses when another record took the linked account meanwhile', async () => {
    const { ctx, account } = await setup();
    const savings = await createAsset(ctx, {
      kind: 'cash',
      name: 'Savings',
      accountId: account.id,
    });
    await disposeAsset(ctx, savings.id, { kind: 'written_off', date: '2026-03-10' });
    await createAsset(ctx, { kind: 'cash', name: 'Other', accountId: account.id });
    expect(await codeOf(undoAssetDisposal(ctx, savings.id))).toBe('account_already_linked');
  });

  it('delete is owner only, cascades valuations and nulls liability.asset_id', async () => {
    const { ctx, car } = await setup();
    await addAssetValuation(ctx, car.id, { asOf: '2026-03-01', value: 100 });
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', assetId: car.id });
    await expect(deleteAsset(withRole(ctx, 'member'), car.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await deleteAsset(ctx, car.id);
    expect(await t.owner.select().from(asset).where(eq(asset.id, car.id))).toEqual([]);
    expect(
      await t.owner.select().from(assetValuation).where(eq(assetValuation.assetId, car.id)),
    ).toEqual([]);
    const [l] = await t.owner.select().from(liability).where(eq(liability.id, loan.id));
    expect(l!.assetId).toBeNull();
  });

  it('viewers cannot dispose or undo', async () => {
    const { ctx, car } = await setup();
    const viewer = withRole(ctx, 'viewer');
    await expect(
      disposeAsset(viewer, car.id, { kind: 'written_off', date: '2026-03-10' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(undoAssetDisposal(viewer, car.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('listAssets hides disposed unless asked', async () => {
    const { ctx, car } = await setup();
    await disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10' });
    expect((await listAssets(ctx)).map((a) => a.id)).not.toContain(car.id);
    expect((await listAssets(ctx, { includeDisposed: true })).map((a) => a.id)).toContain(car.id);
  });

  it('a disposed asset frees its account', async () => {
    const { ctx, account } = await setup();
    const first = await createAsset(ctx, { kind: 'cash', name: 'A', accountId: account.id });
    expect(await codeOf(createAsset(ctx, { kind: 'cash', name: 'B', accountId: account.id }))).toBe(
      'account_already_linked',
    );
    await disposeAsset(ctx, first.id, { kind: 'written_off', date: '2026-03-10' });
    const second = await createAsset(ctx, { kind: 'cash', name: 'B', accountId: account.id });
    expect(second.accountId).toBe(account.id);
    await expect(updateAsset(ctx, second.id, { name: 'B2' })).resolves.toBeDefined();
  });

  it('AI valuation skips disposed assets', async () => {
    const ctx = await t.household();
    await t.owner
      .update(schema.householdSettings)
      .set({ aiEnabled: true })
      .where(eq(schema.householdSettings.householdId, ctx.householdId));
    const addFlat = async (name: string) => {
      const [row] = await t.owner
        .insert(asset)
        .values({
          householdId: ctx.householdId,
          kind: 'real_estate',
          name,
          currency: 'EUR',
          details: {
            propertyType: 'apartment',
            typology: 'T2',
            municipality: 'Lisboa',
            areaM2: 85,
          },
          aiValuation: true,
          aiRequestedAt: new Date('2026-10-31T10:00:00Z'),
        })
        .returning();
      return row!;
    };
    const live = await addFlat('Live flat');
    const gone = await addFlat('Sold flat');
    await disposeAsset(ctx, gone.id, { kind: 'written_off', date: '2026-03-10' });
    const due = await claimDueAssetValuations(t.db, {
      now: new Date('2026-10-31T12:00:00Z'),
      limit: 1_000,
      tz: 'UTC',
    });
    expect(due.map((d) => d.assetId)).toContain(live.id);
    expect(due.map((d) => d.assetId)).not.toContain(gone.id);
  });

  describe('listSaleCandidates', () => {
    it('filters and searches', async () => {
      const { ctx, account, car } = await setup();
      const boat = await createAsset(ctx, { kind: 'vehicle', name: 'Boat' });
      const archivedAccount = await createAccount(ctx, { name: 'Old', type: 'checking' });
      const good = await addTx(ctx, account.id, {
        bookingDate: '2026-03-12',
        rawDescription: 'TRF Joao Silva',
      });
      const newer = await addTx(ctx, account.id, {
        bookingDate: '2026-04-01',
        rawDescription: 'Payment',
        counterparty: 'Maria Cars',
      });
      const taken = await addTx(ctx, account.id, { bookingDate: '2026-05-01' });
      await disposeAsset(ctx, boat.id, { kind: 'sold', transactionId: taken.id });
      await addTx(ctx, account.id, { status: 'pending' });
      await addTx(ctx, account.id, { amount: -100 });
      await addTx(ctx, account.id, { amount: 0 });
      await addTx(ctx, account.id, { transferGroupId: crypto.randomUUID() });
      const usd = await createAccount(ctx, { name: 'USD', type: 'checking', currency: 'USD' });
      await addTx(ctx, usd.id, { currency: 'USD' });
      await addTx(ctx, archivedAccount.id);
      await t.owner
        .update(schema.financialAccount)
        .set({ archivedAt: new Date() })
        .where(eq(schema.financialAccount.id, archivedAccount.id));

      const all = await listSaleCandidates(ctx, car.id, {});
      expect(all.map((c) => c.id)).toEqual([newer.id, good.id]);
      expect(all[0]).toEqual({
        id: newer.id,
        bookingDate: '2026-04-01',
        amount: 20_000_00,
        currency: 'EUR',
        accountId: account.id,
        accountName: 'Current',
        description: 'Maria Cars',
      });
      expect(all[1]!.description).toBe('TRF Joao Silva');
      expect((await listSaleCandidates(ctx, car.id, { search: 'joao' })).map((c) => c.id)).toEqual([
        good.id,
      ]);
      expect((await listSaleCandidates(ctx, car.id, { search: 'MARIA' })).map((c) => c.id)).toEqual(
        [newer.id],
      );
      expect(await listSaleCandidates(ctx, car.id, { limit: 1 })).toHaveLength(1);
      // a non-finite limit falls back to the default
      expect(await listSaleCandidates(ctx, car.id, { limit: Number.NaN })).toHaveLength(2);
      await expect(
        listSaleCandidates(ctx, car.id, { search: 'x'.repeat(201) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(listSaleCandidates(ctx, car.id, { search: 'x'.repeat(200) })).resolves.toEqual(
        [],
      );
      // the asset that took a transaction still sees it as its own
      expect((await listSaleCandidates(ctx, boat.id, {})).map((c) => c.id)).toContain(taken.id);
    });
  });

  it('refuses a valuation on or after the disposal day, and accepts one before it', async () => {
    const { ctx, car } = await setup();
    await disposeAsset(ctx, car.id, { kind: 'written_off', date: '2026-03-10' });
    const valueOn = (asOf: string) => addAssetValuation(ctx, car.id, { asOf, value: 1_000_00 });
    const err = await valueOn('2026-03-10').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('asset_disposed');
    expect((err as ValidationError).issues).toEqual([
      { path: ['asOf'], message: expect.any(String) },
    ]);
    expect(await codeOf(valueOn('2026-03-11'))).toBe('asset_disposed');
    const before = await valueOn('2026-03-09');
    expect(before).toMatchObject({ asOf: '2026-03-09', value: 1_000_00, method: 'manual' });
  });
});
