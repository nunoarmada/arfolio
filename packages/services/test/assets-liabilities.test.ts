import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  addAssetValuation,
  addLiabilityBalance,
  archiveAsset,
  archiveLiability,
  createAccount,
  createAsset,
  createLiability,
  deleteAssetValuation,
  deleteLiabilityBalance,
  ForbiddenError,
  listAssets,
  listAssetValuations,
  listLiabilities,
  listLiabilityBalances,
  NotFoundError,
  requestAssetEstimate,
  saveLiabilitySchedule,
  scheduleFor,
  updateAsset,
  updateLiability,
  ValidationError,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('assets and liabilities', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  describe('assets', () => {
    it('creates with the household currency, lists, updates and archives', async () => {
      const ctx = await t.household({ currency: 'EUR' });
      const house = await createAsset(ctx, { kind: 'real_estate', name: ' House ' });
      expect(house).toMatchObject({ name: 'House', currency: 'EUR', archived: false });
      const car = await createAsset(ctx, {
        kind: 'vehicle',
        name: 'Car',
        depreciationBpsPerYear: 1500,
        position: 1,
      });
      expect((await listAssets(ctx)).map((a) => a.name)).toEqual(['House', 'Car']);

      const renamed = await updateAsset(ctx, car.id, {
        name: 'Old car',
        depreciationBpsPerYear: null,
      });
      expect(renamed).toMatchObject({ name: 'Old car', depreciationBpsPerYear: null });

      await archiveAsset(ctx, car.id);
      expect((await listAssets(ctx)).map((a) => a.name)).toEqual(['House']);
      expect(await listAssets(ctx, { includeArchived: true })).toHaveLength(2);
    });

    it('is read-only for viewers', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'cash', name: 'Jar' });
      const viewer = withRole(ctx, 'viewer');
      expect(await listAssets(viewer)).toHaveLength(1);
      await expect(createAsset(viewer, { kind: 'cash', name: 'x' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(updateAsset(viewer, a.id, { name: 'y' })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(archiveAsset(viewer, a.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        addAssetValuation(viewer, a.id, { asOf: '2026-01-01', value: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses to link an asset to a credit card', async () => {
      const ctx = await t.household();
      const card = await createAccount(ctx, { name: 'Card', type: 'card' });
      await expect(
        createAsset(ctx, { kind: 'cash', name: 'x', accountId: card.id }),
      ).rejects.toBeInstanceOf(ValidationError);
      const a = await createAsset(ctx, { kind: 'cash', name: 'y' });
      await expect(updateAsset(ctx, a.id, { accountId: card.id })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects a link to another household account and invalid input', async () => {
      const ctx = await t.household();
      const other = await t.household();
      const foreign = await createAccount(other, { name: 'Theirs', type: 'savings' });
      await expect(
        createAsset(ctx, { kind: 'cash', name: 'x', accountId: foreign.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(createAsset(ctx, { kind: 'boat' as never, name: 'x' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        createAsset(ctx, { kind: 'vehicle', name: 'x', depreciationBpsPerYear: 10_001 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(updateAsset(ctx, 'nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateAsset(other, (await createAsset(ctx, { kind: 'cash', name: 'm' })).id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a manual value replacing an ai value of the same day drops the estimate', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await t.owner.insert(schema.assetValuation).values({
        householdId: ctx.householdId,
        assetId: a.id,
        asOf: '2026-03-31',
        value: 30_000_000,
        method: 'ai',
        estimate: { low: 1, high: 2, confidence: 'low', sources: [] },
      });
      const row = await addAssetValuation(ctx, a.id, { asOf: '2026-03-31', value: 25_000_000 });
      expect(row).toMatchObject({ value: 25_000_000, method: 'manual', estimate: null });
    });

    it('valuations: one per day (re-adding replaces), newest first, deletable', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await addAssetValuation(ctx, a.id, { asOf: '2026-01-31', value: 20_000_000 });
      await addAssetValuation(ctx, a.id, { asOf: '2026-06-30', value: 21_000_000, note: 'bank' });
      await addAssetValuation(ctx, a.id, { asOf: '2026-01-31', value: 20_500_000 });
      const rows = await listAssetValuations(ctx, a.id);
      expect(rows.map((r) => [r.asOf, r.value, r.method])).toEqual([
        ['2026-06-30', 21_000_000, 'manual'],
        ['2026-01-31', 20_500_000, 'manual'],
      ]);
      await deleteAssetValuation(ctx, rows[0]!.id);
      expect(await listAssetValuations(ctx, a.id)).toHaveLength(1);
      await expect(deleteAssetValuation(ctx, rows[0]!.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        addAssetValuation(ctx, a.id, { asOf: '2026-02-30', value: 1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        addAssetValuation(ctx, a.id, { asOf: '2026-02-01', value: -1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      // import, connector and depreciation values are written by their own paths only
      for (const method of ['import', 'connector', 'depreciation'] as const) {
        await expect(
          addAssetValuation(ctx, a.id, { asOf: '2026-02-01', value: 1, method } as never),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(
        addAssetValuation(ctx, '00000000-0000-4000-8000-000000000000', {
          asOf: '2026-02-01',
          value: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('asset details and the AI switch', () => {
    const flat = {
      propertyType: 'apartment',
      municipality: 'Lisboa',
      areaM2: 80,
    } as const;
    const codeOf = async (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => (e as ValidationError).code,
      );

    it('stores details and the switch on create and asks for an estimate', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, {
        kind: 'real_estate',
        name: 'Flat',
        details: flat,
        aiValuation: true,
      });
      expect(a.details).toEqual(flat);
      expect(a.aiValuation).toBe(true);
      expect(a.aiRequestedAt).toBeInstanceOf(Date);
    });

    it('turning the switch on clears the depreciation rate', async () => {
      const ctx = await t.household();
      const car = await createAsset(ctx, {
        kind: 'vehicle',
        name: 'Car',
        depreciationBpsPerYear: 1500,
      });
      const on = await updateAsset(ctx, car.id, { aiValuation: true });
      expect(on).toMatchObject({ aiValuation: true, depreciationBpsPerYear: null });
      expect(on.aiRequestedAt).toBeInstanceOf(Date);
    });

    it('refuses the switch for cash or a linked account', async () => {
      const ctx = await t.household();
      expect(await codeOf(createAsset(ctx, { kind: 'cash', name: 'Jar', aiValuation: true }))).toBe(
        'ai_not_eligible',
      );
      const acc = await createAccount(ctx, { name: 'S', type: 'savings' });
      expect(
        await codeOf(
          createAsset(ctx, { kind: 'other', name: 'x', accountId: acc.id, aiValuation: true }),
        ),
      ).toBe('ai_not_eligible');
    });

    it('rejects invalid details and details on investment or cash', async () => {
      const ctx = await t.household();
      await expect(
        createAsset(ctx, { kind: 'real_estate', name: 'x', details: { postalCode: 'x' } }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createAsset(ctx, { kind: 'cash', name: 'x', details: { areaM2: 1 } }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('drops empty-string and null keys; an emptied object is stored as null', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, {
        kind: 'real_estate',
        name: 'x',
        details: { municipality: 'Porto', parish: '', postalCode: null },
      });
      expect(a.details).toEqual({ municipality: 'Porto' });
      const b = await createAsset(ctx, {
        kind: 'real_estate',
        name: 'y',
        details: { parish: '' },
      });
      expect(b.details).toBeNull();
    });

    it('a details change while AI is on re-requests and clears the last error', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, {
        kind: 'real_estate',
        name: 'Flat',
        details: flat,
        aiValuation: true,
      });
      await t.db.execute(
        sql`update asset set ai_last_error = 'boom', ai_requested_at = '2020-01-01' where id = ${a.id}`,
      );
      const b = await updateAsset(ctx, a.id, { details: { ...flat, areaM2: 90 } });
      expect(b.details).toMatchObject({ areaM2: 90 });
      expect(b.aiLastError).toBeNull();
      expect(b.aiRequestedAt!.getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
    });

    it('linking an account forces the switch off', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'other', name: 'x', aiValuation: true });
      const acc = await createAccount(ctx, { name: 'S', type: 'savings' });
      const linked = await updateAsset(ctx, a.id, { accountId: acc.id });
      expect(linked.aiValuation).toBe(false);
    });

    it('changing the kind revalidates details; investment or cash nulls them and the switch', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, {
        kind: 'real_estate',
        name: 'Flat',
        details: flat,
        aiValuation: true,
      });
      await expect(updateAsset(ctx, a.id, { kind: 'vehicle' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      const cash = await updateAsset(ctx, a.id, { kind: 'cash' });
      expect(cash).toMatchObject({ details: null, aiValuation: false });
    });

    it('refuses a depreciation rate while AI is on', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'vehicle', name: 'Car', aiValuation: true });
      expect(await codeOf(updateAsset(ctx, a.id, { depreciationBpsPerYear: 500 }))).toBe(
        'ai_depreciation_conflict',
      );
      const off = await updateAsset(ctx, a.id, { aiValuation: false, depreciationBpsPerYear: 500 });
      expect(off).toMatchObject({ aiValuation: false, depreciationBpsPerYear: 500 });
    });

    it('allows the switch with missing details', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'vehicle', name: 'Car', aiValuation: true });
      expect(a.aiValuation).toBe(true);
    });

    it('requestAssetEstimate: writer only, needs the switch on', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'vehicle', name: 'Car', aiValuation: true });
      await expect(requestAssetEstimate(withRole(ctx, 'viewer'), a.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await t.db.execute(
        sql`update asset set ai_last_error = 'boom', ai_requested_at = '2020-01-01' where id = ${a.id}`,
      );
      const r = await requestAssetEstimate(ctx, a.id);
      expect(r.aiLastError).toBeNull();
      expect(r.aiRequestedAt!.getTime()).toBeGreaterThan(new Date('2021-01-01').getTime());
      const off = await createAsset(ctx, { kind: 'vehicle', name: 'Off' });
      expect(await codeOf(requestAssetEstimate(ctx, off.id))).toBe('ai_not_eligible');
    });

    it('manual valuations stay manual and carry no estimate', async () => {
      const ctx = await t.household();
      const a = await createAsset(ctx, { kind: 'vehicle', name: 'Car', aiValuation: true });
      const v = await addAssetValuation(ctx, a.id, { asOf: '2026-01-01', value: 100 });
      expect(v).toMatchObject({ method: 'manual', estimate: null });
    });
  });

  describe('one record per account', () => {
    const codeOf = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).code;
    };

    it('refuses linking an account another live asset or liability already counts', async () => {
      const ctx = await t.household();
      const acc = await createAccount(ctx, { name: 'Savings', type: 'savings' });
      const loan = await createAccount(ctx, { name: 'Loan', type: 'loan' });
      const fund = await createAsset(ctx, { kind: 'cash', name: 'Fund', accountId: acc.id });
      expect(
        await codeOf(createAsset(ctx, { kind: 'cash', name: 'Twice', accountId: acc.id })),
      ).toBe('account_already_linked');
      expect(
        await codeOf(createLiability(ctx, { kind: 'debt', name: 'Owed', accountId: acc.id })),
      ).toBe('account_already_linked');
      const other = await createAsset(ctx, { kind: 'cash', name: 'Other' });
      expect(await codeOf(updateAsset(ctx, other.id, { accountId: acc.id }))).toBe(
        'account_already_linked',
      );
      const mortgage = await createLiability(ctx, {
        kind: 'mortgage',
        name: 'Mortgage',
        accountId: loan.id,
      });
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Debt' });
      expect(await codeOf(updateLiability(ctx, debt.id, { accountId: loan.id }))).toBe(
        'account_already_linked',
      );
      // a record keeps its own link, and archiving frees the account
      expect((await updateAsset(ctx, fund.id, { accountId: acc.id, name: 'Fund 2' })).name).toBe(
        'Fund 2',
      );
      expect((await updateLiability(ctx, mortgage.id, { accountId: loan.id })).accountId).toBe(
        loan.id,
      );
      await archiveAsset(ctx, fund.id);
      expect((await updateAsset(ctx, other.id, { accountId: acc.id })).accountId).toBe(acc.id);
    });
  });

  describe('liabilities', () => {
    it('creates, lists, updates and archives; validates principal and links', async () => {
      const ctx = await t.household({ currency: 'EUR' });
      const house = await createAsset(ctx, { kind: 'real_estate', name: 'House' });
      const m = await createLiability(ctx, {
        kind: 'mortgage',
        name: 'Mortgage',
        assetId: house.id,
        principal: 20_000_000,
      });
      expect(m).toMatchObject({ currency: 'EUR', principal: 20_000_000, assetId: house.id });
      await expect(
        createLiability(ctx, { kind: 'loan', name: 'x', principal: -1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      const other = await t.household();
      const foreignAsset = await createAsset(other, { kind: 'cash', name: 'x' });
      await expect(
        createLiability(ctx, { kind: 'loan', name: 'x', assetId: foreignAsset.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const upd = await updateLiability(ctx, m.id, { name: 'Home loan', notes: 'fixed' });
      expect(upd).toMatchObject({ name: 'Home loan', notes: 'fixed' });
      await archiveLiability(ctx, m.id);
      expect(await listLiabilities(ctx)).toEqual([]);
      expect(await listLiabilities(ctx, { includeArchived: true })).toHaveLength(1);
      const viewer = withRole(ctx, 'viewer');
      await expect(createLiability(viewer, { kind: 'debt', name: 'x' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('balances: upsert per day, newest first, deletable, never negative', async () => {
      const ctx = await t.household();
      const l = await createLiability(ctx, { kind: 'debt', name: 'Friend' });
      await addLiabilityBalance(ctx, l.id, { asOf: '2026-01-31', balance: 50_000 });
      await addLiabilityBalance(ctx, l.id, { asOf: '2026-03-31', balance: 30_000 });
      await addLiabilityBalance(ctx, l.id, { asOf: '2026-01-31', balance: 45_000 });
      const rows = await listLiabilityBalances(ctx, l.id);
      expect(rows.map((r) => [r.asOf, r.balance, r.source])).toEqual([
        ['2026-03-31', 30_000, 'manual'],
        ['2026-01-31', 45_000, 'manual'],
      ]);
      // import, connector and schedule balances are written by their own paths only
      for (const source of ['import', 'connector', 'schedule'] as const) {
        await expect(
          addLiabilityBalance(ctx, l.id, { asOf: '2026-04-30', balance: 1, source } as never),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(
        addLiabilityBalance(ctx, l.id, { asOf: '2026-04-30', balance: -1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await deleteLiabilityBalance(ctx, rows[0]!.id);
      expect(await listLiabilityBalances(ctx, l.id)).toHaveLength(1);
      await expect(deleteLiabilityBalance(ctx, rows[0]!.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('schedule: saved on the liability and returned by scheduleFor from core', async () => {
      const ctx = await t.household();
      const l = await createLiability(ctx, { kind: 'loan', name: 'Car loan' });
      expect(await scheduleFor(ctx, l.id)).toBeNull();
      const saved = await saveLiabilitySchedule(ctx, l.id, {
        principal: 1_200_000,
        annualRateBps: 0,
        termMonths: 12,
        startDate: '2026-01-15',
      });
      expect(saved).toMatchObject({
        principal: 1_200_000,
        termMonths: 12,
        startDate: '2026-01-15',
      });
      const s = await scheduleFor(ctx, l.id);
      expect(s!.payment).toBe(100_000);
      expect(s!.rows).toHaveLength(12);
      expect(s!.rows[0]).toMatchObject({ n: 1, date: '2026-02-15', balance: 1_100_000 });
      expect(s!.rows[11]!.balance).toBe(0);
      await expect(
        saveLiabilitySchedule(ctx, l.id, {
          principal: 1,
          annualRateBps: 0,
          termMonths: 0,
          startDate: '2026-01-01',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        saveLiabilitySchedule(withRole(ctx, 'viewer'), l.id, {
          principal: 1,
          annualRateBps: 0,
          termMonths: 1,
          startDate: '2026-01-01',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(scheduleFor(ctx, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
