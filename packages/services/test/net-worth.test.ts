import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import {
  accountBalancesAt,
  addAssetValuation,
  addLiabilityBalance,
  archiveAccount,
  archiveAsset,
  archiveLiability,
  createAccount,
  createAsset,
  createLiability,
  deleteAssetValuation,
  deleteLiabilityBalance,
  ForbiddenError,
  latestValues,
  listAccounts,
  netWorthAt,
  netWorthHistory,
  recalculateNetWorthSnapshot,
  saveLiabilitySchedule,
  snapshotNetWorth,
  snapshotPreviousMonth,
  updateAccount,
  updateAsset,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { refreshAllStoredSnapshotsInTx } from '../src/net-worth.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const {
  transaction,
  balanceSnapshot,
  positionSnapshot,
  netWorthSnapshot,
  householdSettings,
  asset: assetTable,
  liability: liabilityTable,
} = schema;

describe('net worth', () => {
  let t: ServicesTestDb;
  let hash = 0;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world(currency = 'EUR'): Promise<ServiceCtx> {
    const ctx = await t.household({ currency });
    await t.owner
      .update(householdSettings)
      .set({ timezone: 'UTC' })
      .where(eq(householdSettings.householdId, ctx.householdId));
    return ctx;
  }
  const book = (
    ctx: ServiceCtx,
    accountId: string,
    bookingDate: string,
    amount: number,
    status: 'booked' | 'pending' = 'booked',
  ) =>
    t.owner.insert(transaction).values({
      householdId: ctx.householdId,
      accountId,
      dedupeHash: `n${(hash += 1)}`,
      bookingDate,
      amount,
      currency: 'EUR',
      status,
      rawDescription: 'x',
      source: 'manual',
    });
  const snap = (ctx: ServiceCtx, accountId: string, asOf: string, balance: number) =>
    t.owner.insert(balanceSnapshot).values({
      householdId: ctx.householdId,
      accountId,
      asOf,
      balance,
      currency: 'EUR',
      source: 'connector',
    });

  const dispose = (id: string, on: string) =>
    t.owner
      .update(assetTable)
      .set({ disposedOn: on, disposalKind: 'written_off' })
      .where(eq(assetTable.id, id));
  const settle = (id: string, on: string) =>
    t.owner.update(liabilityTable).set({ settledOn: on }).where(eq(liabilityTable.id, id));

  describe('accountBalancesAt', () => {
    it('is opening balance plus booked transactions up to the date, pending ignored', async () => {
      const ctx = await world();
      const a = await createAccount(ctx, {
        name: 'Main',
        type: 'checking',
        openingBalance: 100_000,
        openingBalanceDate: '2026-01-01',
      });
      await book(ctx, a.id, '2026-01-01', -9_999); // on the opening date: already in the opening balance
      await book(ctx, a.id, '2026-02-10', 20_000);
      await book(ctx, a.id, '2026-03-10', -5_000);
      await book(ctx, a.id, '2026-02-11', 777, 'pending');
      const feb = await accountBalancesAt(ctx, '2026-02-28');
      expect(feb).toEqual([
        expect.objectContaining({ accountId: a.id, balance: 120_000, source: 'ledger' }),
      ]);
      expect((await accountBalancesAt(ctx, '2026-03-31'))[0]!.balance).toBe(115_000);
      // the account does not exist yet: no phantom opening balance
      expect(await accountBalancesAt(ctx, '2025-12-31')).toEqual([]);
    });

    it('anchors on a connector balance and adds the bookings dated after it', async () => {
      const ctx = await world();
      const a = await createAccount(ctx, { name: 'Bank', type: 'checking', openingBalance: 0 });
      await book(ctx, a.id, '2026-03-05', 10_000);
      await snap(ctx, a.id, '2026-03-31', 12_345);
      expect((await accountBalancesAt(ctx, '2026-03-31'))[0]).toMatchObject({
        balance: 12_345,
        source: 'snapshot',
        asOf: '2026-03-31',
      });
      // Same day: a connector balance is taken to include that day's bookings.
      await book(ctx, a.id, '2026-03-31', 111);
      expect((await accountBalancesAt(ctx, '2026-03-31'))[0]).toMatchObject({
        balance: 12_345,
        source: 'snapshot',
      });
      // A booking after the anchor moves the balance on from the anchor, not from the ledger.
      await book(ctx, a.id, '2026-04-02', 500);
      await book(ctx, a.id, '2026-04-09', 900, 'pending');
      expect((await accountBalancesAt(ctx, '2026-04-30'))[0]).toMatchObject({
        balance: 12_845,
        source: 'snapshot',
        asOf: '2026-04-02',
      });
      // A snapshot dated after the requested date is not visible then.
      expect((await accountBalancesAt(ctx, '2026-03-20'))[0]).toMatchObject({
        balance: 10_000,
        source: 'ledger',
      });
    });

    it('values investment accounts by their latest positions on or before the date', async () => {
      const ctx = await world();
      const inv = await createAccount(ctx, { name: 'T212', type: 'investment', openingBalance: 1 });
      const pos = (asOf: string, instrument: string, valueMinor: number) =>
        t.owner.insert(positionSnapshot).values({
          householdId: ctx.householdId,
          accountId: inv.id,
          asOf,
          instrument,
          quantity: '1',
          priceMinor: valueMinor,
          valueMinor,
          currency: 'EUR',
        });
      await pos('2026-01-31', 'AAA', 10_000);
      await pos('2026-02-28', 'AAA', 11_000);
      await pos('2026-02-28', 'BBB', 4_000);
      expect((await accountBalancesAt(ctx, '2026-02-28'))[0]).toMatchObject({
        balance: 15_000,
        source: 'positions',
      });
      expect((await accountBalancesAt(ctx, '2026-02-15'))[0]).toMatchObject({ balance: 10_000 });
      expect((await accountBalancesAt(ctx, '2026-01-15'))[0]).toMatchObject({
        balance: 1,
        source: 'ledger',
      });
    });

    it('lists positions in another currency as foreign instead of dropping them', async () => {
      const ctx = await world();
      const inv = await createAccount(ctx, {
        name: 'Broker',
        type: 'investment',
        openingBalance: 0,
      });
      const pos = (instrument: string, valueMinor: number, currency: string) =>
        t.owner.insert(positionSnapshot).values({
          householdId: ctx.householdId,
          accountId: inv.id,
          asOf: '2026-02-28',
          instrument,
          quantity: '1',
          priceMinor: valueMinor,
          valueMinor,
          currency,
        });
      await pos('AAA', 10_000, 'EUR');
      await pos('US1', 3_000, 'USD');
      await pos('US2', 500, 'USD');
      const nw = await netWorthAt(ctx, '2026-02-28');
      expect(nw.assets).toBe(10_000);
      expect(nw.foreign.map((i) => [i.refId, i.kind, i.currency, i.amount])).toEqual([
        [inv.id, 'investment', 'USD', 3_500],
      ]);
    });

    it('leaves out archived accounts and accounts excluded from net worth', async () => {
      const ctx = await world();
      const keep = await createAccount(ctx, { name: 'Keep', type: 'checking', openingBalance: 1 });
      const hidden = await createAccount(ctx, {
        name: 'Hidden',
        type: 'checking',
        openingBalance: 2,
        includeInNetWorth: false,
      });
      const gone = await createAccount(ctx, { name: 'Gone', type: 'savings', openingBalance: 3 });
      await t.owner
        .update(schema.financialAccount)
        .set({ archivedAt: new Date() })
        .where(eq(schema.financialAccount.id, gone.id));
      void hidden;
      expect((await accountBalancesAt(ctx, '2026-06-30')).map((r) => r.accountId)).toEqual([
        keep.id,
      ]);
    });
  });

  describe('connector balance anchor', () => {
    const kindSnap = (
      ctx: ServiceCtx,
      accountId: string,
      asOf: string,
      source: string,
      balance: number,
      currency = 'EUR',
    ) =>
      t.owner.insert(balanceSnapshot).values({
        householdId: ctx.householdId,
        accountId,
        asOf,
        balance,
        currency,
        source,
      });
    // A linked connector account, as connections.ts creates it: opening 0, no opening date.
    const linkedAccount = (
      ctx: ServiceCtx,
      name: string,
      type: 'checking' | 'savings' | 'card' | 'investment' | 'loan',
    ) => createAccount(ctx, { name, type, openingBalance: 0 });
    const pos = (
      ctx: ServiceCtx,
      accountId: string,
      asOf: string,
      instrument: string,
      valueMinor: number,
      currency = 'EUR',
    ) =>
      t.owner.insert(positionSnapshot).values({
        householdId: ctx.householdId,
        accountId,
        asOf,
        instrument,
        quantity: '1',
        priceMinor: valueMinor,
        valueMinor,
        currency,
      });

    it('a 12 000 EUR account stays anchored when a booking lands after the closing balance', async () => {
      const ctx = await world();
      const a = await linkedAccount(ctx, 'Bank', 'checking');
      await kindSnap(ctx, a.id, '2026-10-20', 'enablebanking:CLBD', 1_200_000);
      await book(ctx, a.id, '2026-10-05', -30_000);
      await book(ctx, a.id, '2026-10-12', -15_000);
      await book(ctx, a.id, '2026-10-21', -5_000);
      expect((await netWorthAt(ctx, '2026-10-20')).net).toBe(1_200_000);
      const on21 = await netWorthAt(ctx, '2026-10-21');
      expect(on21.net).toBe(1_195_000);
      expect(on21.items).toEqual([
        expect.objectContaining({
          side: 'asset',
          kind: 'cash',
          amount: 1_195_000,
          asOf: '2026-10-21',
        }),
      ]);
      // The account page reads the same balance.
      expect((await listAccounts(ctx)).find((x) => x.id === a.id)?.balance).toBe(1_195_000);
    });

    it('prefers CLBD > ITBD > OPBD/PRCD > XPCD > trading212:total on the same day, never an available or INFO kind', async () => {
      const ctx = await world();
      const one = await linkedAccount(ctx, 'One', 'checking');
      // CLBD written first, so the newest row of the day is not the one that should win
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:CLBD', 100_000);
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:XPCD', 100_500);
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:ITBD', 100_700);
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:ITAV', 900_000);
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:CLAV', 800_000);
      await kindSnap(ctx, one.id, '2026-05-31', 'enablebanking:INFO', 700_000);
      const two = await linkedAccount(ctx, 'Two', 'checking');
      await kindSnap(ctx, two.id, '2026-05-31', 'enablebanking:ITBD', 200_000);
      await kindSnap(ctx, two.id, '2026-05-31', 'enablebanking:OPBD', 200_100);
      await kindSnap(ctx, two.id, '2026-05-31', 'enablebanking:XPCD', 200_200);
      const three = await linkedAccount(ctx, 'Three', 'checking');
      await kindSnap(ctx, three.id, '2026-05-31', 'enablebanking:XPCD', 300_200);
      await kindSnap(ctx, three.id, '2026-05-31', 'enablebanking:PRCD', 300_000);
      const four = await linkedAccount(ctx, 'Four', 'checking');
      await kindSnap(ctx, four.id, '2026-05-31', 'enablebanking:XPCD', 400_000);
      await kindSnap(ctx, four.id, '2026-05-31', 'enablebanking:FWAV', 999_999);
      // only INFO and a forward available kind: no anchor, the ledger stands
      const five = await createAccount(ctx, {
        name: 'Five',
        type: 'checking',
        openingBalance: 500,
      });
      await kindSnap(ctx, five.id, '2026-05-31', 'enablebanking:FWAV', 999_999);
      await kindSnap(ctx, five.id, '2026-05-31', 'enablebanking:INFO', 999_999);
      const got = new Map(
        (await accountBalancesAt(ctx, '2026-05-31')).map((r) => [
          r.accountId,
          [r.balance, r.source],
        ]),
      );
      expect(got.get(one.id)).toEqual([100_000, 'snapshot']);
      expect(got.get(two.id)).toEqual([200_000, 'snapshot']);
      expect(got.get(three.id)).toEqual([300_000, 'snapshot']);
      expect(got.get(four.id)).toEqual([400_000, 'snapshot']);
      expect(got.get(five.id)).toEqual([500, 'ledger']);
    });

    it('anchors an account that only reports available balances on CLAV, then ITAV, plus later bookings', async () => {
      const ctx = await world();
      // ITAV only
      const rev = await linkedAccount(ctx, 'Neobank', 'checking');
      await kindSnap(ctx, rev.id, '2026-10-29', 'enablebanking:ITAV', 283_065);
      await book(ctx, rev.id, '2026-10-20', -5_000);
      await book(ctx, rev.id, '2026-10-30', -1_000);
      const both = await linkedAccount(ctx, 'Both', 'savings');
      await kindSnap(ctx, both.id, '2026-10-29', 'enablebanking:ITAV', 2_000);
      await kindSnap(ctx, both.id, '2026-10-29', 'enablebanking:CLAV', 1_000);
      const got = new Map(
        (await accountBalancesAt(ctx, '2026-10-31')).map((r) => [
          r.accountId,
          [r.balance, r.source],
        ]),
      );
      expect(got.get(rev.id)).toEqual([282_065, 'snapshot']);
      expect(got.get(both.id)).toEqual([1_000, 'snapshot']);
      expect((await listAccounts(ctx)).find((x) => x.id === rev.id)?.balance).toBe(282_065);
    });

    it('prefers an older booked balance to a newer available one, and never anchors a card or loan on an available balance', async () => {
      const ctx = await world();
      const bank = await linkedAccount(ctx, 'Bank', 'checking');
      await kindSnap(ctx, bank.id, '2026-05-01', 'enablebanking:CLBD', 50_000);
      await kindSnap(ctx, bank.id, '2026-05-20', 'enablebanking:ITAV', 99_000);
      const card = await linkedAccount(ctx, 'Visa', 'card');
      await kindSnap(ctx, card.id, '2026-05-20', 'enablebanking:ITAV', 420_000);
      const loan = await linkedAccount(ctx, 'Loan', 'loan');
      await kindSnap(ctx, loan.id, '2026-05-20', 'enablebanking:CLAV', 420_000);
      const got = new Map(
        (await accountBalancesAt(ctx, '2026-05-31')).map((r) => [
          r.accountId,
          [r.balance, r.source],
        ]),
      );
      expect(got.get(bank.id)).toEqual([50_000, 'snapshot']);
      expect(got.get(card.id)).toEqual([0, 'ledger']);
      expect(got.get(loan.id)).toEqual([0, 'ledger']);
    });

    it('takes the latest date before the kind, and ignores a balance in another currency', async () => {
      const ctx = await world();
      const a = await linkedAccount(ctx, 'Bank', 'checking');
      await kindSnap(ctx, a.id, '2026-05-01', 'enablebanking:CLBD', 50_000);
      await kindSnap(ctx, a.id, '2026-05-10', 'enablebanking:XPCD', 60_000);
      await kindSnap(ctx, a.id, '2026-05-20', 'enablebanking:CLBD', 7_000, 'USD');
      await book(ctx, a.id, '2026-05-15', 1_000);
      expect((await accountBalancesAt(ctx, '2026-05-31'))[0]).toMatchObject({
        balance: 61_000,
        source: 'snapshot',
        asOf: '2026-05-15',
      });
    });

    it('a card with CLBD -800 and ITAV +4200 owes 800, it is not a 4200 asset', async () => {
      const ctx = await world();
      const card = await linkedAccount(ctx, 'Visa', 'card');
      await kindSnap(ctx, card.id, '2026-06-30', 'enablebanking:ITAV', 420_000);
      await kindSnap(ctx, card.id, '2026-06-30', 'enablebanking:CLBD', -80_000);
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect([nw.assets, nw.liabilities, nw.net]).toEqual([0, 80_000, -80_000]);
      expect(nw.byKind).toEqual({ 'liability:card': 80_000 });
      expect((await listAccounts(ctx))[0]!.balance).toBe(-80_000);
      expect((await listAccounts(ctx))[0]!.owed).toBe(80_000);
    });

    it('a card whose bank reports available credit owes its limit minus that balance', async () => {
      const ctx = await world();
      const card = await createAccount(ctx, {
        name: 'Bank card',
        type: 'card',
        openingBalance: 0,
        creditLimit: 100_000,
      });
      await kindSnap(ctx, card.id, '2026-06-30', 'enablebanking:CLBD', 98_305);
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect([nw.assets, nw.liabilities, nw.net]).toEqual([0, 1_695, -1_695]);
      expect(nw.byKind).toEqual({ 'liability:card': 1_695 });
      const [row] = await listAccounts(ctx);
      expect([row!.balance, row!.owed, row!.creditLimit]).toEqual([98_305, 1_695, 100_000]);
    });

    it('a card with a positive bank balance and no limit is never an asset', async () => {
      const ctx = await world();
      const card = await linkedAccount(ctx, 'Bank card', 'card');
      await kindSnap(ctx, card.id, '2026-06-30', 'enablebanking:CLBD', 98_305);
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect([nw.assets, nw.liabilities]).toEqual([0, 0]);
      expect(Object.keys(nw.byKind).filter((k) => k.startsWith('asset:'))).toEqual([]);
      expect((await listAccounts(ctx))[0]!.owed).toBe(0);
    });

    it('a limit does not reinterpret a ledger balance: a negative ledger card owes its balance', async () => {
      const ctx = await world();
      await createAccount(ctx, {
        name: 'Manual card',
        type: 'card',
        openingBalance: -2_000,
        creditLimit: 100_000,
      });
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect(nw.byKind).toEqual({ 'liability:card': 2_000 });
      expect((await listAccounts(ctx))[0]!.owed).toBe(2_000);
    });

    it('non-card accounts have no owed amount', async () => {
      const ctx = await world();
      await createAccount(ctx, { name: 'Check', type: 'checking', openingBalance: 5_000 });
      expect((await listAccounts(ctx))[0]!.owed).toBeNull();
    });

    it('Trading 212: total (cash included) is the balance, not positions, and no foreign positions are listed', async () => {
      const ctx = await world();
      const inv = await linkedAccount(ctx, 'T212', 'investment');
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:cash', 500_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:investments', 1_000_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:total', 1_500_000);
      await pos(ctx, inv.id, '2026-02-28', 'AAA', 997_000);
      await pos(ctx, inv.id, '2026-02-28', 'US1', 3_000, 'USD');
      expect((await accountBalancesAt(ctx, '2026-02-28'))[0]).toMatchObject({
        balance: 1_500_000,
        cash: 500_000,
        invested: 1_000_000,
        source: 'snapshot',
      });
      const nw = await netWorthAt(ctx, '2026-02-28');
      expect(nw.assets).toBe(1_500_000);
      expect(nw.foreign).toEqual([]);
      expect(nw.byKind).toEqual({ 'asset:cash': 500_000, 'asset:investment': 1_000_000 });
      expect(
        nw.items
          .filter((i) => i.refId === inv.id)
          .map((i) => [i.kind, i.amount])
          .sort(),
      ).toEqual([
        ['cash', 500_000],
        ['investment', 1_000_000],
      ]);
      expect((await listAccounts(ctx))[0]).toMatchObject({
        balance: 1_500_000,
        cash: 500_000,
        invested: 1_000_000,
      });
    });

    it('Trading 212: money booked after the balance day is cash, the invested value stays', async () => {
      const ctx = await world();
      const inv = await linkedAccount(ctx, 'T212', 'investment');
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:cash', 500_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:investments', 1_000_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:total', 1_500_000);
      await book(ctx, inv.id, '2026-03-02', 20_000);
      expect((await accountBalancesAt(ctx, '2026-03-05'))[0]).toMatchObject({
        balance: 1_520_000,
        cash: 520_000,
        invested: 1_000_000,
      });
    });

    it('Trading 212: all in cash is one cash item in net worth', async () => {
      const ctx = await world();
      const inv = await linkedAccount(ctx, 'T212', 'investment');
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:cash', 1_400_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:investments', 0);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:total', 1_400_000);
      const nw = await netWorthAt(ctx, '2026-02-28');
      expect(nw.byKind).toEqual({ 'asset:cash': 1_400_000 });
      expect(nw.items.filter((i) => i.refId === inv.id)).toHaveLength(1);
    });

    it('other accounts: a bank account is all cash, any other investment account all invested', async () => {
      const ctx = await world();
      const bank = await createAccount(ctx, {
        name: 'Bank',
        type: 'checking',
        openingBalance: 300,
      });
      const broker = await createAccount(ctx, {
        name: 'Broker',
        type: 'investment',
        openingBalance: 900,
      });
      const byId = new Map(
        (await accountBalancesAt(ctx, '2026-02-28')).map((b) => [b.accountId, b]),
      );
      expect(byId.get(bank.id)).toMatchObject({ balance: 300, cash: 300, invested: 0 });
      expect(byId.get(broker.id)).toMatchObject({ balance: 900, cash: 0, invested: 900 });
      expect((await netWorthAt(ctx, '2026-02-28')).byKind).toEqual({
        'asset:cash': 300,
        'asset:investment': 900,
      });
    });

    it('Trading 212: a sold-out portfolio is not valued at its last positions', async () => {
      const ctx = await world();
      const inv = await linkedAccount(ctx, 'T212', 'investment');
      await pos(ctx, inv.id, '2026-01-31', 'AAA', 1_000_000);
      await pos(ctx, inv.id, '2026-01-31', 'US1', 3_000, 'USD');
      await kindSnap(ctx, inv.id, '2026-01-31', 'trading212:total', 1_500_000);
      // everything sold in February: savePositions leaves no rows for that day
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:cash', 1_400_000);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:investments', 0);
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:total', 1_400_000);
      expect((await accountBalancesAt(ctx, '2026-02-28'))[0]).toMatchObject({
        balance: 1_400_000,
      });
      expect((await netWorthAt(ctx, '2026-02-28')).foreign).toEqual([]);
    });

    it('positions count only without a total and when not older than the latest balance', async () => {
      const ctx = await world();
      const inv = await createAccount(ctx, {
        name: 'Broker',
        type: 'investment',
        openingBalance: 7,
      });
      await pos(ctx, inv.id, '2026-01-31', 'AAA', 1_000_000);
      await pos(ctx, inv.id, '2026-01-31', 'US1', 3_000, 'USD');
      await kindSnap(ctx, inv.id, '2026-01-31', 'trading212:cash', 1);
      expect((await accountBalancesAt(ctx, '2026-01-31'))[0]).toMatchObject({
        balance: 1_000_000,
        source: 'positions',
      });
      expect((await netWorthAt(ctx, '2026-01-31')).foreign).toHaveLength(1);
      // a newer balance with no positions that day: the positions are stale (sold out)
      await kindSnap(ctx, inv.id, '2026-02-28', 'trading212:cash', 1);
      expect((await accountBalancesAt(ctx, '2026-02-28'))[0]).toMatchObject({
        balance: 7,
        source: 'ledger',
      });
      expect((await netWorthAt(ctx, '2026-02-28')).foreign).toEqual([]);
    });
  });

  describe('latestValues', () => {
    it('gives nulls for a record with no value yet, and skips archived records', async () => {
      const ctx = await world();
      const empty = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
      const gone = await createAsset(ctx, { kind: 'cash', name: 'Gone' });
      await addAssetValuation(ctx, gone.id, { asOf: '2026-01-01', value: 1 });
      await archiveAsset(ctx, gone.id);

      expect(await latestValues(ctx, '2026-06-30')).toEqual([
        { refId: empty.id, side: 'asset', asOf: null, value: null, source: null },
        { refId: loan.id, side: 'liability', asOf: null, value: null, source: null },
      ]);
    });

    it('omits a disposed asset and a settled liability from their date on', async () => {
      const ctx = await world();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      await addAssetValuation(ctx, car.id, { asOf: '2026-01-01', value: 100_000 });
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Friend', principal: 5_000 });
      await dispose(car.id, '2026-06-15');
      await settle(debt.id, '2026-06-15');

      const refs = async (date: string) => (await latestValues(ctx, date)).map((v) => v.refId);
      expect((await refs('2026-06-14')).sort()).toEqual([car.id, debt.id].sort());
      expect(await refs('2026-06-15')).toEqual([]);
      expect(await refs('2026-07-01')).toEqual([]);
    });

    it('ignores a value dated after the date', async () => {
      const ctx = await world();
      const flat = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await addAssetValuation(ctx, flat.id, { asOf: '2026-02-01', value: 100_000 });
      await addAssetValuation(ctx, flat.id, { asOf: '2026-09-01', value: 150_000 });
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Debt' });
      await addLiabilityBalance(ctx, debt.id, { asOf: '2026-12-01', balance: 3_000 });

      const rows = await latestValues(ctx, '2026-06-30');
      expect(rows.find((r) => r.refId === flat.id)).toEqual({
        refId: flat.id,
        side: 'asset',
        asOf: '2026-02-01',
        value: 100_000,
        source: 'manual',
      });
      expect(rows.find((r) => r.refId === debt.id)).toMatchObject({ asOf: null, value: null });
      expect((await latestValues(ctx, '2026-12-31')).find((r) => r.refId === debt.id)).toEqual({
        refId: debt.id,
        side: 'liability',
        asOf: '2026-12-01',
        value: 3_000,
        source: 'manual',
      });
    });

    it('takes the newest by date: a manual value beats an older import value', async () => {
      const ctx = await world();
      const flat = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      // import-sourced rows are written by the importer, not the public API
      await t.owner.insert(schema.assetValuation).values({
        householdId: ctx.householdId,
        assetId: flat.id,
        asOf: '2026-01-31',
        value: 90_000,
        method: 'import',
      });
      await addAssetValuation(ctx, flat.id, {
        asOf: '2026-03-10',
        value: 95_000,
        method: 'manual',
      });
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Debt' });
      await addLiabilityBalance(ctx, debt.id, {
        asOf: '2026-01-31',
        balance: 8_000,
        source: 'manual',
      });
      await t.owner.insert(schema.liabilityBalance).values({
        householdId: ctx.householdId,
        liabilityId: debt.id,
        asOf: '2026-02-28',
        balance: 7_000,
        source: 'import',
      });

      const rows = await latestValues(ctx, '2026-06-30');
      expect(rows.find((r) => r.refId === flat.id)).toMatchObject({
        asOf: '2026-03-10',
        value: 95_000,
        source: 'manual',
      });
      expect(rows.find((r) => r.refId === debt.id)).toMatchObject({
        asOf: '2026-02-28',
        value: 7_000,
        source: 'import',
      });
    });

    it('defaults to today in the household time zone, validates the date and is readable by viewers', async () => {
      const ctx = await world();
      const flat = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await addAssetValuation(ctx, flat.id, { asOf: '2000-01-01', value: 10 });
      await addAssetValuation(ctx, flat.id, { asOf: '2999-01-01', value: 99 });
      const viewer = withRole(ctx, 'viewer');
      expect(await latestValues(viewer)).toEqual([
        { refId: flat.id, side: 'asset', asOf: '2000-01-01', value: 10, source: 'manual' },
      ]);
      await expect(latestValues(ctx, 'tomorrow')).rejects.toBeInstanceOf(ValidationError);
      const other = await world();
      expect(await latestValues(other)).toEqual([]);
    });
  });

  describe('netWorthAt', () => {
    it('classifies accounts: loans and negative balances are liabilities, others assets by type', async () => {
      const ctx = await world();
      await createAccount(ctx, { name: 'Check', type: 'checking', openingBalance: 100_000 });
      await createAccount(ctx, { name: 'Save', type: 'savings', openingBalance: 50_000 });
      await createAccount(ctx, { name: 'Inv', type: 'investment', openingBalance: 30_000 });
      await createAccount(ctx, { name: 'Zero', type: 'cash', openingBalance: 0 });
      await createAccount(ctx, { name: 'Visa', type: 'card', openingBalance: -20_000 });
      await createAccount(ctx, { name: 'Overdraft', type: 'checking', openingBalance: -1_000 });
      await createAccount(ctx, { name: 'Car loan', type: 'loan', openingBalance: -400_000 });
      await createAccount(ctx, { name: 'Odd loan', type: 'loan', openingBalance: 5_000 }); // sign irrelevant
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect(nw.assets).toBe(180_000);
      expect(nw.liabilities).toBe(20_000 + 1_000 + 400_000 + 5_000);
      expect(nw.net).toBe(180_000 - 426_000);
      expect(nw.byKind).toEqual({
        'asset:cash': 150_000,
        'asset:investment': 30_000,
        'liability:card': 20_000,
        'liability:debt': 1_000,
        'liability:loan': 405_000,
      });
      expect(nw.foreign).toEqual([]);
      expect(nw.items.every((i) => !i.linked && !i.foreignCurrency)).toBe(true);
    });

    it('counts a linked asset or liability through its account once, and shows it as linked', async () => {
      const ctx = await world();
      const savings = await createAccount(ctx, {
        name: 'Save',
        type: 'savings',
        openingBalance: 80_000,
      });
      const loanAcc = await createAccount(ctx, {
        name: 'Mortgage acc',
        type: 'loan',
        openingBalance: -900_000,
      });
      const house = await createAsset(ctx, { kind: 'real_estate', name: 'House' });
      await addAssetValuation(ctx, house.id, { asOf: '2026-01-01', value: 2_000_000 });
      const linkedAsset = await createAsset(ctx, {
        kind: 'cash',
        name: 'Nest egg',
        accountId: savings.id,
      });
      await addAssetValuation(ctx, linkedAsset.id, { asOf: '2026-01-01', value: 999_999 });
      const mortgage = await createLiability(ctx, {
        kind: 'mortgage',
        name: 'Mortgage',
        accountId: loanAcc.id,
        principal: 1_000_000,
      });
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect(nw.assets).toBe(80_000 + 2_000_000);
      expect(nw.liabilities).toBe(900_000);
      const linked = nw.items.filter((i) => i.linked);
      expect(linked.map((i) => [i.source, i.refId, i.viaAccountId, i.amount]).sort()).toEqual(
        [
          ['asset', linkedAsset.id, savings.id, 0],
          ['liability', mortgage.id, loanAcc.id, 0],
        ].sort(),
      );
    });

    it('a disposed asset counts before its date and not from it', async () => {
      const ctx = await world();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      await addAssetValuation(ctx, car.id, { asOf: '2026-01-01', value: 100_000 });
      await dispose(car.id, '2026-06-15');

      const before = await netWorthAt(ctx, '2026-06-14');
      expect(before.assets).toBe(100_000);
      expect(before.items.map((i) => i.refId)).toContain(car.id);
      expect(before.byKind['asset:vehicle']).toBe(100_000);
      const from = await netWorthAt(ctx, '2026-06-15');
      expect(from.assets).toBe(0);
      expect(from.items.map((i) => i.refId)).not.toContain(car.id);
      expect(from.byKind['asset:vehicle']).toBeUndefined();
    });

    it('a settled liability counts before its date and not from it', async () => {
      const ctx = await world();
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Friend', principal: 5_000 });
      await settle(debt.id, '2026-06-15');

      const before = await netWorthAt(ctx, '2026-06-14');
      expect(before.liabilities).toBe(5_000);
      expect(before.items.map((i) => i.refId)).toContain(debt.id);
      const from = await netWorthAt(ctx, '2026-06-15');
      expect(from.liabilities).toBe(0);
      expect(from.items.map((i) => i.refId)).not.toContain(debt.id);
    });

    it('a disposed account-linked asset loses its linked item from its date', async () => {
      const ctx = await world();
      const savings = await createAccount(ctx, {
        name: 'Save',
        type: 'savings',
        openingBalance: 80_000,
      });
      const nest = await createAsset(ctx, { kind: 'cash', name: 'Nest', accountId: savings.id });
      await dispose(nest.id, '2026-06-15');

      const linkedRefs = async (date: string) =>
        (await netWorthAt(ctx, date)).items.filter((i) => i.linked).map((i) => i.refId);
      expect(await linkedRefs('2026-06-14')).toEqual([nest.id]);
      expect(await linkedRefs('2026-06-15')).toEqual([]);
    });

    it('byKind uses the linked record kind while the account supplies the amount, once', async () => {
      const ctx = await world();
      const loanAcc = await createAccount(ctx, {
        name: 'Loan',
        type: 'loan',
        openingBalance: -900_000,
      });
      const brokerage = await createAccount(ctx, {
        name: 'Save',
        type: 'savings',
        openingBalance: 80_000,
      });
      await createLiability(ctx, { kind: 'mortgage', name: 'Mortgage', accountId: loanAcc.id });
      await createAsset(ctx, { kind: 'investment', name: 'Fund', accountId: brokerage.id });
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect(nw.byKind).toEqual({ 'liability:mortgage': 900_000, 'asset:investment': 80_000 });
      expect(nw.net).toBe(80_000 - 900_000);
    });

    it('carries valuations forward and omits an asset before its first valuation', async () => {
      const ctx = await world();
      const flat = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await addAssetValuation(ctx, flat.id, { asOf: '2026-02-15', value: 100_000 });
      await addAssetValuation(ctx, flat.id, { asOf: '2026-05-15', value: 110_000 });
      expect((await netWorthAt(ctx, '2026-01-31')).assets).toBe(0);
      expect((await netWorthAt(ctx, '2026-03-31')).assets).toBe(100_000);
      expect((await netWorthAt(ctx, '2026-05-15')).assets).toBe(110_000);
      expect((await netWorthAt(ctx, '2026-12-31')).byKind).toEqual({
        'asset:real_estate': 110_000,
      });
      await archiveAsset(ctx, flat.id);
      expect((await netWorthAt(ctx, '2026-12-31')).assets).toBe(0);
    });

    it('lists an asset or liability without a value as hasValue false, leaving the totals alone', async () => {
      const ctx = await world();
      const cash = await createAsset(ctx, { kind: 'cash', name: 'Stash' });
      await addAssetValuation(ctx, cash.id, { asOf: '2026-02-15', value: 5_000 });
      const flat = await createAsset(ctx, { kind: 'real_estate', name: 'Flat' });
      await addAssetValuation(ctx, flat.id, { asOf: '2026-05-15', value: 100_000 });
      const empty = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
      const unborrowed = await createLiability(ctx, {
        kind: 'mortgage',
        name: 'Later',
        principal: 90_000,
        startDate: '2026-09-01',
      });

      const nw = await netWorthAt(ctx, '2026-03-31');
      const byRef = new Map(nw.items.map((i) => [i.refId, i]));
      expect(nw.assets).toBe(5_000);
      expect(nw.liabilities).toBe(0);
      expect(nw.byKind).toEqual({ 'asset:cash': 5_000 });
      for (const id of [flat.id, empty.id, loan.id, unborrowed.id]) {
        expect(byRef.get(id), id).toMatchObject({ amount: 0, hasValue: false, asOf: null });
      }
      expect(byRef.get(cash.id)).toMatchObject({
        amount: 5_000,
        hasValue: true,
        asOf: '2026-02-15',
      });
      expect(nw.foreign).toEqual([]);
      expect(
        (await netWorthAt(ctx, '2026-06-30')).items.find((i) => i.refId === flat.id),
      ).toMatchObject({
        amount: 100_000,
        hasValue: true,
        asOf: '2026-05-15',
      });
    });

    it('gives every other item hasValue true and the date that supplied it', async () => {
      const ctx = await world();
      const ledger = await createAccount(ctx, {
        name: 'Ledger',
        type: 'checking',
        openingBalance: 1_000,
        openingBalanceDate: '2026-01-01',
      });
      const booked = await createAccount(ctx, {
        name: 'Booked',
        type: 'checking',
        openingBalance: 1_000,
        openingBalanceDate: '2026-01-01',
      });
      await book(ctx, booked.id, '2026-02-10', 500);
      const snapped = await createAccount(ctx, { name: 'Snapped', type: 'checking' });
      await snap(ctx, snapped.id, '2026-02-20', 7_000);
      const invest = await createAccount(ctx, { name: 'Broker', type: 'investment' });
      await t.owner.insert(positionSnapshot).values({
        householdId: ctx.householdId,
        accountId: invest.id,
        asOf: '2026-03-15',
        instrument: 'VWCE',
        quantity: '1',
        priceMinor: 20_000,
        valueMinor: 20_000,
        currency: 'EUR',
      });
      const linkedAsset = await createAsset(ctx, {
        kind: 'cash',
        name: 'Linked',
        accountId: ledger.id,
      });
      const debt = await createLiability(ctx, { kind: 'loan', name: 'Loan', principal: 10_000 });
      await addLiabilityBalance(ctx, debt.id, { asOf: '2026-02-01', balance: 9_000 });
      const sched = await createLiability(ctx, { kind: 'debt', name: 'Principal', principal: 500 });

      const nw = await netWorthAt(ctx, '2026-03-31');
      const byRef = new Map(nw.items.map((i) => [i.refId, i]));
      expect(nw.items.every((i) => i.hasValue)).toBe(true);
      expect(byRef.get(ledger.id)!.asOf).toBeNull();
      expect(byRef.get(booked.id)!.asOf).toBe('2026-02-10');
      expect(byRef.get(snapped.id)!.asOf).toBe('2026-02-20');
      expect(byRef.get(invest.id)).toMatchObject({ amount: 20_000, asOf: '2026-03-15' });
      expect(byRef.get(linkedAsset.id)).toMatchObject({ linked: true, hasValue: true, asOf: null });
      expect(byRef.get(debt.id)!.asOf).toBe('2026-02-01');
      expect(byRef.get(sched.id)).toMatchObject({ amount: 500, hasValue: true, asOf: null });
    });

    it('depreciates from the last manual valuation to the date', async () => {
      const ctx = await world();
      const car = await createAsset(ctx, {
        kind: 'vehicle',
        name: 'Car',
        depreciationBpsPerYear: 1_200,
      });
      await addAssetValuation(ctx, car.id, { asOf: '2026-01-31', value: 1_000_000 });
      expect((await netWorthAt(ctx, '2026-01-31')).assets).toBe(1_000_000);
      // 12 whole months at 1200 bps/year = 1%/month compounded: 1_000_000 * 0.99^12
      expect((await netWorthAt(ctx, '2027-01-31')).assets).toBe(886_385);
      // a stored 'depreciation' valuation never serves as the base
      await t.owner.insert(schema.assetValuation).values({
        householdId: ctx.householdId,
        assetId: car.id,
        asOf: '2026-07-31',
        value: 1,
        method: 'depreciation',
      });
      expect((await netWorthAt(ctx, '2027-01-31')).assets).toBe(886_385);
    });

    it('liabilities: latest balance, else schedule balance, else principal', async () => {
      const ctx = await world();
      const withBalance = await createLiability(ctx, {
        kind: 'debt',
        name: 'Friend',
        principal: 100_000,
      });
      await addLiabilityBalance(ctx, withBalance.id, { asOf: '2026-02-28', balance: 80_000 });
      await addLiabilityBalance(ctx, withBalance.id, { asOf: '2026-04-30', balance: 60_000 });
      const scheduled = await createLiability(ctx, { kind: 'loan', name: 'Sched' });
      await saveLiabilitySchedule(ctx, scheduled.id, {
        principal: 1_200_000,
        annualRateBps: 0,
        termMonths: 12,
        startDate: '2026-01-31',
      });
      await createLiability(ctx, { kind: 'other', name: 'Flat principal', principal: 7_000 });
      await createLiability(ctx, { kind: 'other', name: 'Nothing known' });

      const mar = await netWorthAt(ctx, '2026-03-31');
      // 80_000 (balance) + 1_200_000 - 2*100_000 (schedule after 2 instalments) + 7_000
      expect(mar.liabilities).toBe(80_000 + 1_000_000 + 7_000);
      const jun = await netWorthAt(ctx, '2026-06-30');
      expect(jun.liabilities).toBe(60_000 + 700_000 + 7_000);
      // before the loan started nothing is owed on it; items without a start date count throughout
      const before = await netWorthAt(ctx, '2025-12-31');
      expect(before.liabilities).toBe(100_000 + 7_000);
    });

    it('lists other-currency items as foreign and leaves them out of the totals', async () => {
      const ctx = await world('EUR');
      await createAccount(ctx, { name: 'EUR acc', type: 'checking', openingBalance: 10_000 });
      await createAccount(ctx, {
        name: 'USD acc',
        type: 'savings',
        currency: 'USD',
        openingBalance: 99_000,
      });
      const us = await createAsset(ctx, { kind: 'real_estate', name: 'Cabin', currency: 'USD' });
      await addAssetValuation(ctx, us.id, { asOf: '2026-01-01', value: 5_000_000 });
      const nw = await netWorthAt(ctx, '2026-06-30');
      expect(nw.assets).toBe(10_000);
      expect(nw.foreign.map((i) => [i.name, i.currency, i.amount]).sort()).toEqual([
        ['Cabin', 'USD', 5_000_000],
        ['USD acc', 'USD', 99_000],
      ]);
      expect(nw.items.filter((i) => i.foreignCurrency)).toHaveLength(2);
      expect(nw.byKind).toEqual({ 'asset:cash': 10_000 });
    });

    it('is readable by viewers and scoped to the household', async () => {
      const ctx = await world();
      const other = await world();
      await createAccount(other, { name: 'Theirs', type: 'checking', openingBalance: 999 });
      await createAccount(ctx, { name: 'Mine', type: 'checking', openingBalance: 5 });
      expect((await netWorthAt(withRole(ctx, 'viewer'), '2026-06-30')).assets).toBe(5);
      await expect(netWorthAt(ctx, '2026-13-01')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('snapshots', () => {
    it('stores the month-end value once; recomputing replaces it', async () => {
      const ctx = await world();
      const a = await createAccount(ctx, {
        name: 'Main',
        type: 'checking',
        openingBalance: 10_000,
      });
      await createAccount(ctx, {
        name: 'USD',
        type: 'checking',
        currency: 'USD',
        openingBalance: 1,
      });
      await createLiability(ctx, { kind: 'debt', name: 'Owed', principal: 3_000 });
      await book(ctx, a.id, '2026-03-31', 1_000);
      await book(ctx, a.id, '2026-04-01', 50_000); // after month end: not in March
      const deps = { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') };
      const first = await snapshotNetWorth(deps, ctx.householdId, '2026-03-01');
      expect(first).toMatchObject({
        month: '2026-03-01',
        assets: 11_000,
        liabilities: 3_000,
        net: 8_000,
      });
      expect(first.breakdown).toEqual({
        byKind: { 'asset:cash': 11_000, 'liability:debt': 3_000 },
        foreignCount: 1,
      });

      await book(ctx, a.id, '2026-03-15', 500); // late-arriving data for March
      const again = await snapshotNetWorth(deps, ctx.householdId, '2026-03-01');
      expect(again.net).toBe(8_500);
      const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.select().from(netWorthSnapshot).where(eq(netWorthSnapshot.householdId, ctx.householdId)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ net: 8_500, assets: 11_500 });
    });

    it('disposal keeps earlier months', async () => {
      const ctx = await world();
      const car = await createAsset(ctx, { kind: 'vehicle', name: 'Car' });
      await addAssetValuation(ctx, car.id, { asOf: '2026-01-01', value: 100_000 });
      const deps = { db: ctx.db, now: new Date('2026-07-10T12:00:00Z') };
      await snapshotNetWorth(deps, ctx.householdId, '2026-05-01');
      await snapshotNetWorth(deps, ctx.householdId, '2026-06-01');
      await dispose(car.id, '2026-06-15');
      await withHousehold(ctx.db, ctx.householdId, (tx) =>
        refreshAllStoredSnapshotsInTx(tx, ctx.householdId),
      );

      const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.select().from(netWorthSnapshot).where(eq(netWorthSnapshot.householdId, ctx.householdId)),
      );
      const net = (month: string) => rows.find((r) => r.month === month)!.net;
      expect(net('2026-05-01')).toBe(100_000);
      expect(net('2026-06-01')).toBe(0);
    });

    it('a back-dated value, balance or deletion refreshes the stored months from its month on, never filling gaps', async () => {
      const ctx = await world();
      const stored = async () =>
        new Map(
          (
            await withHousehold(ctx.db, ctx.householdId, (tx) =>
              tx
                .select()
                .from(netWorthSnapshot)
                .where(eq(netWorthSnapshot.householdId, ctx.householdId)),
            )
          ).map((r) => [r.month, r.net]),
        );
      const house = await createAsset(ctx, { kind: 'real_estate', name: 'House' });
      const debt = await createLiability(ctx, { kind: 'debt', name: 'Debt' });
      await addAssetValuation(ctx, house.id, { asOf: '2026-01-10', value: 100_000 });
      const deps = { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') };
      for (const month of ['2026-01-01', '2026-03-01', '2026-04-01']) {
        await snapshotNetWorth(deps, ctx.householdId, month); // February left as a gap
      }
      const feb = await addAssetValuation(ctx, house.id, { asOf: '2026-02-20', value: 150_000 });
      expect(await stored()).toEqual(
        new Map([
          ['2026-01-01', 100_000],
          ['2026-03-01', 150_000],
          ['2026-04-01', 150_000],
        ]),
      );
      const bal = await addLiabilityBalance(ctx, debt.id, { asOf: '2026-03-05', balance: 20_000 });
      expect(await stored()).toEqual(
        new Map([
          ['2026-01-01', 100_000],
          ['2026-03-01', 130_000],
          ['2026-04-01', 130_000],
        ]),
      );
      await deleteAssetValuation(ctx, feb.id);
      expect((await stored()).get('2026-03-01')).toBe(80_000);
      await deleteLiabilityBalance(ctx, bal.id);
      expect(await stored()).toEqual(
        new Map([
          ['2026-01-01', 100_000],
          ['2026-03-01', 100_000],
          ['2026-04-01', 100_000],
        ]),
      );
    });

    it('editing, excluding or archiving an account refreshes the stored months', async () => {
      const ctx = await world();
      const storedNet = async () =>
        (
          await withHousehold(ctx.db, ctx.householdId, (tx) =>
            tx
              .select()
              .from(netWorthSnapshot)
              .where(eq(netWorthSnapshot.householdId, ctx.householdId)),
          )
        ).find((r) => r.month === '2026-03-01')!.net;
      const main = await createAccount(ctx, {
        name: 'Main',
        type: 'checking',
        openingBalance: 10_000,
        openingBalanceDate: '2026-01-01',
      });
      const side = await createAccount(ctx, {
        name: 'Side',
        type: 'checking',
        openingBalance: 5_000,
        openingBalanceDate: '2026-01-01',
      });
      const deps = { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') };
      await snapshotNetWorth(deps, ctx.householdId, '2026-03-01');
      expect(await storedNet()).toBe(15_000);

      await updateAccount(ctx, side.id, { includeInNetWorth: false });
      expect(await storedNet()).toBe(10_000);
      await updateAccount(ctx, side.id, { includeInNetWorth: true });
      expect(await storedNet()).toBe(15_000);

      await updateAccount(ctx, main.id, { openingBalance: 12_000 });
      expect(await storedNet()).toBe(17_000);

      await archiveAccount(ctx, side.id);
      expect(await storedNet()).toBe(await netWorthAt(ctx, '2026-03-31').then((r) => r.net));
      expect(await storedNet()).toBe(12_000);
    });

    it('a rate, schedule or archive change refreshes the stored months in the same transaction', async () => {
      const ctx = await world();
      const storedNet = async (month: string) =>
        (
          await withHousehold(ctx.db, ctx.householdId, (tx) =>
            tx
              .select()
              .from(netWorthSnapshot)
              .where(eq(netWorthSnapshot.householdId, ctx.householdId)),
          )
        ).find((r) => r.month === month)!.net;
      const liveNet = async (date: string) => (await netWorthAt(ctx, date)).net;
      const house = await createAsset(ctx, { kind: 'real_estate', name: 'House' });
      const loan = await createLiability(ctx, { kind: 'loan', name: 'Loan' });
      await addAssetValuation(ctx, house.id, { asOf: '2026-01-10', value: 100_000 });
      const deps = { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') };
      await snapshotNetWorth(deps, ctx.householdId, '2026-01-01');
      await snapshotNetWorth(deps, ctx.householdId, '2026-03-01');
      expect(await storedNet('2026-03-01')).toBe(100_000);
      const months = async () =>
        (
          await withHousehold(ctx.db, ctx.householdId, (tx) =>
            tx
              .select()
              .from(netWorthSnapshot)
              .where(eq(netWorthSnapshot.householdId, ctx.householdId)),
          )
        )
          .map((r) => r.month)
          .sort();
      expect(await months()).toEqual(['2026-01-01', '2026-03-01']); // February is a gap

      await updateAsset(ctx, house.id, { depreciationBpsPerYear: 2_400 });
      const depreciated = await storedNet('2026-03-01');
      expect(depreciated).toBeLessThan(100_000);
      expect(depreciated).toBe(await liveNet('2026-03-31'));

      await saveLiabilitySchedule(ctx, loan.id, {
        principal: 12_000,
        annualRateBps: 0,
        termMonths: 12,
        startDate: '2026-01-15',
      });
      const withLoan = await storedNet('2026-03-01');
      expect(withLoan).toBeLessThan(depreciated);
      expect(withLoan).toBe(await liveNet('2026-03-31'));

      expect(await months()).toEqual(['2026-01-01', '2026-03-01']); // a refresh never fills the gap

      // linking the asset to an account changes past months too
      const acct = await createAccount(ctx, {
        name: 'House fund',
        type: 'savings',
        openingBalance: 7_000,
      });
      const beforeLink = await storedNet('2026-03-01');
      await updateAsset(ctx, house.id, { accountId: acct.id });
      expect(await storedNet('2026-03-01')).toBe(await liveNet('2026-03-31'));
      expect(await storedNet('2026-03-01')).not.toBe(beforeLink);
      await updateAsset(ctx, house.id, { accountId: null });
      expect(await storedNet('2026-03-01')).toBe(beforeLink + 7_000); // the account counts on its own again

      await archiveLiability(ctx, loan.id);
      expect(await storedNet('2026-03-01')).toBe(depreciated + 7_000); // plus the account again
      await archiveAsset(ctx, house.id);
      expect(await storedNet('2026-03-01')).toBe(7_000);
      expect(await storedNet('2026-01-01')).toBe(7_000);
    });

    it('never freezes the current or a future month, and needs a first-of-month date', async () => {
      const ctx = await world();
      const deps = { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') };
      await expect(snapshotNetWorth(deps, ctx.householdId, '2026-06-01')).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(snapshotNetWorth(deps, ctx.householdId, '2026-07-01')).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(snapshotNetWorth(deps, ctx.householdId, '2026-03-15')).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(snapshotNetWorth(deps, ctx.householdId, '2026-05-01')).resolves.toMatchObject({
        net: 0,
      });
    });

    it('snapshotPreviousMonth uses the household calendar', async () => {
      const ctx = await world();
      await createAccount(ctx, { name: 'Main', type: 'checking', openingBalance: 42 });
      const row = await snapshotPreviousMonth(
        { db: ctx.db, now: new Date('2026-01-02T06:30:00Z') },
        ctx.householdId,
      );
      expect(row).toMatchObject({ month: '2025-12-01', net: 42 });
      await t.owner
        .update(householdSettings)
        .set({ timezone: 'Pacific/Auckland' })
        .where(eq(householdSettings.householdId, ctx.householdId));
      // 2026-01-31T12:00Z is already 1 Feb in Auckland: the previous month is January.
      const nz = await snapshotPreviousMonth(
        { db: ctx.db, now: new Date('2026-01-31T12:00:00Z') },
        ctx.householdId,
      );
      expect(nz.month).toBe('2026-01-01');
    });

    it('recalculate is a write: viewers are refused', async () => {
      const ctx = await world();
      const now = new Date('2026-06-10T12:00:00Z');
      await expect(
        recalculateNetWorthSnapshot(withRole(ctx, 'viewer'), '2026-05-01', { now }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        recalculateNetWorthSnapshot(withRole(ctx, 'member'), '2026-05-01', { now }),
      ).resolves.toMatchObject({ month: '2026-05-01' });
    });
  });

  describe('netWorthHistory', () => {
    it('joins stored months with the live current month, omits gaps and computes change', async () => {
      const ctx = await world();
      await createAccount(ctx, { name: 'Main', type: 'checking', openingBalance: 70_000 });
      const put = (month: string, net: number) =>
        withHousehold(ctx.db, ctx.householdId, (tx) =>
          tx.insert(netWorthSnapshot).values({
            householdId: ctx.householdId,
            month,
            assets: net,
            liabilities: 0,
            net,
            breakdown: { byKind: {}, foreignCount: 0 },
          }),
        );
      await put('2026-01-01', 10_000);
      await put('2026-02-01', 20_000);
      // March is missing: a gap, not a zero
      await put('2026-04-01', 50_000);
      await put('2026-05-01', 40_000);
      await put('2025-12-01', 5_000); // outside the requested range
      const now = new Date('2026-06-15T10:00:00Z');
      const rows = await netWorthHistory(ctx, { from: '2026-01-15', to: '2026-06-30' }, { now });
      expect(rows).toEqual([
        { month: '2026-01-01', assets: 10_000, liabilities: 0, net: 10_000, change: null },
        { month: '2026-02-01', assets: 20_000, liabilities: 0, net: 20_000, change: 10_000 },
        { month: '2026-04-01', assets: 50_000, liabilities: 0, net: 50_000, change: 30_000 },
        { month: '2026-05-01', assets: 40_000, liabilities: 0, net: 40_000, change: -10_000 },
        { month: '2026-06-01', assets: 70_000, liabilities: 0, net: 70_000, change: 30_000 },
      ]);
      // the live month is not stored
      const stored = await t.owner
        .select()
        .from(netWorthSnapshot)
        .where(eq(netWorthSnapshot.householdId, ctx.householdId));
      expect(stored.map((r) => r.month)).not.toContain('2026-06-01');
    });

    it('omits months after the current one, leaves change null for a lone month, rejects bad ranges', async () => {
      const ctx = await world();
      await createAccount(ctx, { name: 'Main', type: 'checking', openingBalance: 1 });
      const now = new Date('2026-06-15T10:00:00Z');
      const rows = await netWorthHistory(ctx, { from: '2026-06-01', to: '2027-06-30' }, { now });
      expect(rows).toEqual([
        { month: '2026-06-01', assets: 1, liabilities: 0, net: 1, change: null },
      ]);
      expect(await netWorthHistory(ctx, { from: '2025-01-01', to: '2025-12-31' }, { now })).toEqual(
        [],
      );
      await expect(
        netWorthHistory(ctx, { from: '2026-06-30', to: '2026-01-01' }, { now }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        netWorthHistory(withRole(ctx, 'viewer'), { from: '2026-06-01', to: '2026-06-30' }, { now }),
      ).resolves.toHaveLength(1);
    });
  });
});
