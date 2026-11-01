import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  addLiabilityBalance,
  archiveAsset,
  createAccount,
  createAsset,
  createLiability,
  deleteLiability,
  ForbiddenError,
  householdToday,
  listLiabilities,
  listLiabilityBalances,
  settleLiability,
  unsettleLiability,
  updateLiability,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).code;
  }
  throw new Error('expected a ValidationError');
};

describe('liability settlement and asset links', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const balancesOf = (ctx: ServiceCtx, liabilityId: string) =>
    listLiabilityBalances(ctx, liabilityId);

  it('settles on a date and writes a zero balance', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    const settled = await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    expect(settled.settledOn).toBe('2026-03-10');
    expect(await balancesOf(ctx, loan.id)).toMatchObject([
      { asOf: '2026-03-10', balance: 0, source: 'manual' },
    ]);
  });

  it('keeps an existing balance on that date', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    await addLiabilityBalance(ctx, loan.id, { asOf: '2026-03-10', balance: 5_000 });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    expect(await balancesOf(ctx, loan.id)).toMatchObject([{ asOf: '2026-03-10', balance: 5_000 }]);
  });

  it('writes no balance for an account-linked liability', async () => {
    const ctx = await t.household();
    const account = await createAccount(ctx, { name: 'Loan account', type: 'loan' });
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', accountId: account.id });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    expect(await balancesOf(ctx, loan.id)).toEqual([]);
  });

  it('refuses a future date and an already settled liability', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    const { today } = await householdToday(ctx);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(await codeOf(settleLiability(ctx, loan.id, { date: tomorrow }))).toBe('date_in_future');
    await settleLiability(ctx, loan.id, { date: today });
    expect(await codeOf(settleLiability(ctx, loan.id, { date: today }))).toBe(
      'liability_already_settled',
    );
    expect(await codeOf(unsettleLiability(ctx, (await newLoan(ctx)).id))).toBe(
      'liability_not_settled',
    );
  });

  async function newLoan(ctx: ServiceCtx) {
    return createLiability(ctx, { kind: 'loan', name: 'Other' });
  }

  it('is read-only for viewers', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    await expect(
      settleLiability(withRole(ctx, 'viewer'), loan.id, { date: '2026-03-10' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('runs the onCommit hook inside the transaction', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    const seen: string[] = [];
    await settleLiability(
      ctx,
      loan.id,
      { date: '2026-03-10' },
      { onCommit: async (_tx, r) => void seen.push(r.id) },
    );
    expect(seen).toEqual([loan.id]);
    await expect(
      unsettleLiability(ctx, loan.id, {
        onCommit: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect((await listLiabilities(ctx, { includeSettled: true }))[0]!.settledOn).toBe('2026-03-10');
  });

  it('unsettle clears settled_on and keeps the zero row', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    const reopened = await unsettleLiability(ctx, loan.id);
    expect(reopened.settledOn).toBeNull();
    expect(await balancesOf(ctx, loan.id)).toHaveLength(1);
  });

  it('refuses to unsettle when another record has claimed the account', async () => {
    const ctx = await t.household();
    const account = await createAccount(ctx, { name: 'Loan account', type: 'loan' });
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', accountId: account.id });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    await createAsset(ctx, { kind: 'cash', name: 'Claimer', accountId: account.id });
    expect(await codeOf(unsettleLiability(ctx, loan.id))).toBe('account_already_linked');
    expect((await listLiabilities(ctx, { includeSettled: true }))[0]!.settledOn).toBe('2026-03-10');
  });

  it('delete is owner only and cascades balances', async () => {
    const ctx = await t.household();
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    await expect(deleteLiability(withRole(ctx, 'member'), loan.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await deleteLiability(ctx, loan.id);
    const left = await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx
        .select()
        .from(schema.liabilityBalance)
        .where(eq(schema.liabilityBalance.liabilityId, loan.id)),
    );
    expect(left).toEqual([]);
    expect(await listLiabilities(ctx, { includeSettled: true })).toEqual([]);
  });

  it('listLiabilities hides settled unless asked', async () => {
    const ctx = await t.household();
    const open = await createLiability(ctx, { kind: 'loan', name: 'Open' });
    const done = await createLiability(ctx, { kind: 'loan', name: 'Done' });
    await settleLiability(ctx, done.id, { date: '2026-03-10' });
    expect((await listLiabilities(ctx)).map((l) => l.id)).toEqual([open.id]);
    expect(await listLiabilities(ctx, { includeSettled: true })).toHaveLength(2);
  });

  it('a settled liability frees its account', async () => {
    const ctx = await t.household();
    const account = await createAccount(ctx, { name: 'Loan account', type: 'loan' });
    const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', accountId: account.id });
    await settleLiability(ctx, loan.id, { date: '2026-03-10' });
    await expect(
      createAsset(ctx, { kind: 'cash', name: 'Reuse', accountId: account.id }),
    ).resolves.toBeDefined();
  });

  describe('asset links', () => {
    it('links a loan to a vehicle', async () => {
      const ctx = await t.household();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Car loan', assetId: car.id });
      expect(loan.assetId).toBe(car.id);
    });

    it('refuses a card linked to an asset on create and update', async () => {
      const ctx = await t.household();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      expect(
        await codeOf(createLiability(ctx, { kind: 'card', name: 'Card', assetId: car.id })),
      ).toBe('card_cannot_link_asset');
      const card = await createLiability(ctx, { kind: 'card', name: 'Card' });
      expect(await codeOf(updateLiability(ctx, card.id, { assetId: car.id }))).toBe(
        'card_cannot_link_asset',
      );
    });

    it('refuses changing kind to card while linked, unless the patch clears the link', async () => {
      const ctx = await t.household();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', assetId: car.id });
      expect(await codeOf(updateLiability(ctx, loan.id, { kind: 'card' }))).toBe(
        'card_cannot_link_asset',
      );
      const cleared = await updateLiability(ctx, loan.id, { kind: 'card', assetId: null });
      expect(cleared).toMatchObject({ kind: 'card', assetId: null });
    });

    it('refuses a disposed or archived asset unless already linked', async () => {
      const ctx = await t.household();
      const archived = await createAsset(ctx, { kind: 'vehicle', name: 'Old' });
      const disposed = await createAsset(ctx, { kind: 'vehicle', name: 'Sold' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan', assetId: archived.id });
      await archiveAsset(ctx, archived.id);
      await t.owner
        .update(schema.asset)
        .set({ disposedOn: '2026-01-01', disposalKind: 'sold' })
        .where(and(eq(schema.asset.id, disposed.id)));
      expect(
        await codeOf(createLiability(ctx, { kind: 'loan', name: 'X', assetId: disposed.id })),
      ).toBe('asset_not_live');
      const other = await createLiability(ctx, { kind: 'loan', name: 'Y' });
      expect(await codeOf(updateLiability(ctx, other.id, { assetId: archived.id }))).toBe(
        'asset_not_live',
      );
      // Already pointing at it: an unrelated edit and the same link are fine.
      await expect(
        updateLiability(ctx, loan.id, { assetId: archived.id, name: 'Renamed' }),
      ).resolves.toMatchObject({ name: 'Renamed' });
    });
  });
});
