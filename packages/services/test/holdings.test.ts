import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import { listAccountBuckets, listHoldings, NotFoundError, type ServiceCtx } from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { financialAccount, positionSnapshot, investmentBucket, investmentBucketHolding } = schema;

type Pos = {
  instrument: string;
  ticker?: string | null;
  isin?: string | null;
  name?: string | null;
  quantity?: string;
  value: number;
  cost?: number | null;
  pl?: number | null;
  currency?: string;
};

describe('listHoldings', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
  });
  afterAll(() => t.close());

  async function account(ctx: ServiceCtx, currency = 'EUR'): Promise<string> {
    const [acc] = await t.owner
      .insert(financialAccount)
      .values({ householdId: ctx.householdId, name: 'Broker', type: 'investment', currency })
      .returning({ id: financialAccount.id });
    return acc!.id;
  }

  async function snap(ctx: ServiceCtx, accountId: string, asOf: string, rows: Pos[]) {
    await t.owner.insert(positionSnapshot).values(
      rows.map((r) => ({
        householdId: ctx.householdId,
        accountId,
        asOf,
        instrument: r.instrument,
        ticker: r.ticker === undefined ? r.instrument : r.ticker,
        isin: r.isin ?? null,
        name: r.name === undefined ? r.instrument : r.name,
        quantity: r.quantity ?? '1.0000000000',
        priceMinor: r.value,
        valueMinor: r.value,
        currency: r.currency ?? 'EUR',
        costMinor: r.cost === undefined ? null : r.cost,
        unrealizedPlMinor: r.pl === undefined ? null : r.pl,
      })),
    );
  }

  it('is empty without snapshots', async () => {
    const acc = await account(a);
    expect(await listHoldings(a, acc)).toEqual({
      asOf: null,
      currency: 'EUR',
      total: '0.00',
      items: [],
      groups: null,
    });
  });

  it('lists only the latest day, sorted by value with weights and gains in basis points', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-01', [{ instrument: 'OLD', value: 999_999 }]);
    await snap(a, acc, '2026-10-02', [
      {
        instrument: 'SMALL',
        ticker: 'SML',
        name: 'Small co',
        quantity: '3.5000000000',
        value: 10_000,
        cost: 12_500,
        pl: -2_500,
      },
      {
        instrument: 'XX0000000001',
        ticker: 'VWCE',
        isin: 'XX0000000001',
        name: 'Global ETF',
        quantity: '2.0000000000',
        value: 30_000,
        cost: 22_500,
        pl: 7_500,
      },
    ]);
    const res = await listHoldings(a, acc);
    expect(res).toEqual({
      asOf: '2026-10-02',
      currency: 'EUR',
      total: '400.00',
      items: [
        {
          ticker: 'VWCE',
          name: 'Global ETF',
          isin: 'XX0000000001',
          currency: 'EUR',
          quantity: '2',
          value: '300.00',
          cost: '225.00',
          profit: '75.00',
          profitBps: 3333,
          weightBps: 7500,
        },
        {
          ticker: 'SML',
          name: 'Small co',
          isin: null,
          currency: 'EUR',
          quantity: '3.5',
          value: '100.00',
          cost: '125.00',
          profit: '-25.00',
          profitBps: -2000,
          weightBps: 2500,
        },
      ],
      groups: null,
    });
  });

  it('rounds basis points half away from zero', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [
      // profit/cost = 1/3 -> 3333.33 bps; -2/3 -> -6666.67 -> -6667
      { instrument: 'A', value: 4, cost: 3, pl: 1 },
      { instrument: 'B', value: 1, cost: 3, pl: -2 },
      // weight 1/8 of 8 = 1250; exact half: 5/8... covered by A (4/8 = 5000)
      { instrument: 'C', value: 3 },
    ]);
    const items = Object.fromEntries((await listHoldings(a, acc)).items.map((i) => [i.ticker, i]));
    expect(items.A).toMatchObject({ profitBps: 3333, weightBps: 5000 });
    expect(items.B).toMatchObject({ profitBps: -6667, weightBps: 1250 });
    expect(items.C!.weightBps).toBe(3750);
  });

  it('gives null cost, profit and bps when the cost is unknown, and null bps for zero cost', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [
      { instrument: 'LEGACY', value: 20_000 }, // snapshot before cost was stored
      { instrument: 'FREE', value: 10_000, cost: 0, pl: 10_000 }, // e.g. a gifted share
    ]);
    const items = Object.fromEntries((await listHoldings(a, acc)).items.map((i) => [i.ticker, i]));
    expect(items.LEGACY).toMatchObject({ cost: null, profit: null, profitBps: null });
    expect(items.FREE).toMatchObject({ cost: '0.00', profit: '100.00', profitBps: null });
  });

  it('falls back to the instrument when ticker and name were not stored', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [
      { instrument: 'IE00B3RBWM25', ticker: null, name: null, value: 100 },
    ]);
    const [item] = (await listHoldings(a, acc)).items;
    expect(item).toMatchObject({ ticker: 'IE00B3RBWM25', name: 'IE00B3RBWM25' });
  });

  it('totals and weighs only account-currency positions but still lists foreign ones', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [
      { instrument: 'EURO', value: 10_000 },
      { instrument: 'USD1', value: 50_000, currency: 'USD', cost: 40_000, pl: 10_000 },
    ]);
    const res = await listHoldings(a, acc);
    expect(res.total).toBe('100.00');
    expect(res.items.map((i) => [i.ticker, i.currency, i.value, i.weightBps])).toEqual([
      ['EURO', 'EUR', '100.00', 10_000],
      ['USD1', 'USD', '500.00', null],
    ]);
  });

  it('has null weights when the total is zero', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [{ instrument: 'Z', value: 0 }]);
    expect((await listHoldings(a, acc)).items[0]!.weightBps).toBeNull();
  });

  describe('grouped by pie', () => {
    type Held = { ticker: string; quantity: string; invested: number; value: number };
    async function pie(
      ctx: ServiceCtx,
      accountId: string,
      name: string,
      asOf: string,
      rows: Held[],
    ) {
      const [bucket] = await t.owner
        .insert(investmentBucket)
        .values({
          householdId: ctx.householdId,
          accountId,
          provider: 'trading212',
          externalId: `ext-${name}`,
          name,
        })
        .returning({ id: investmentBucket.id });
      await t.owner.insert(investmentBucketHolding).values(
        rows.map((r) => ({
          bucketId: bucket!.id,
          householdId: ctx.householdId,
          accountId,
          asOf,
          ticker: r.ticker,
          quantity: r.quantity,
          investedMinor: r.invested,
          valueMinor: r.value,
          currency: 'EUR',
        })),
      );
      return bucket!.id;
    }

    async function seeded() {
      const acc = await account(a);
      await snap(a, acc, '2026-10-02', [
        {
          instrument: 'XX0000000001',
          ticker: 'EXA_EQ',
          isin: 'XX0000000001',
          name: 'World ETF',
          quantity: '4',
          value: 40_000,
          cost: 36_000,
          pl: 4_000,
        },
        {
          instrument: 'EXB_EQ',
          name: 'Bond ETF',
          quantity: '2',
          value: 20_000,
          cost: 20_000,
          pl: 0,
        },
        { instrument: 'USD1', value: 5_000, currency: 'USD', cost: 4_000, pl: 1_000 },
      ]);
      return acc;
    }

    it('has no groups without pie instruments', async () => {
      const acc = await seeded();
      await t.owner.insert(investmentBucket).values({
        householdId: a.householdId,
        accountId: acc,
        provider: 'trading212',
        externalId: 'ext-empty',
        name: 'No detail yet',
      });
      expect((await listHoldings(a, acc)).groups).toBeNull();
    });

    it('lists each pie with its instruments, then what is held outside pies', async () => {
      const acc = await seeded();
      const p1 = await pie(a, acc, 'Reforma', '2026-10-02', [
        { ticker: 'EXA_EQ', quantity: '1.5', invested: 13_000, value: 15_000 },
        { ticker: 'EXB_EQ', quantity: '2', invested: 20_500, value: 20_000 },
      ]);
      const p2 = await pie(a, acc, 'Férias', '2026-10-02', [
        { ticker: 'EXA_EQ', quantity: '0.5', invested: 4_000, value: 5_000 },
      ]);
      const res = await listHoldings(a, acc);
      expect(res.total).toBe('600.00');
      expect(res.items).toHaveLength(3);
      expect(res.groups).toEqual([
        {
          id: p1,
          name: 'Reforma',
          currency: 'EUR',
          value: '350.00',
          cost: '335.00',
          profit: '15.00',
          profitBps: 448,
          weightBps: 5833,
          items: [
            {
              ticker: 'EXB_EQ',
              name: 'Bond ETF',
              isin: null,
              currency: 'EUR',
              quantity: '2',
              value: '200.00',
              cost: '205.00',
              profit: '-5.00',
              profitBps: -244,
              weightBps: 3333,
            },
            {
              ticker: 'EXA_EQ',
              name: 'World ETF',
              isin: 'XX0000000001',
              currency: 'EUR',
              quantity: '1.5',
              value: '150.00',
              cost: '130.00',
              profit: '20.00',
              profitBps: 1538,
              weightBps: 2500,
            },
          ],
        },
        {
          id: p2,
          name: 'Férias',
          currency: 'EUR',
          value: '50.00',
          cost: '40.00',
          profit: '10.00',
          profitBps: 2500,
          weightBps: 833,
          items: [expect.objectContaining({ ticker: 'EXA_EQ', quantity: '0.5', value: '50.00' })],
        },
        {
          id: null,
          name: null,
          currency: 'EUR',
          value: '200.00',
          cost: '190.00',
          profit: '10.00',
          profitBps: 526,
          weightBps: 3333,
          items: [
            {
              ticker: 'EXA_EQ',
              name: 'World ETF',
              isin: 'XX0000000001',
              currency: 'EUR',
              quantity: '2',
              value: '200.00',
              cost: '190.00',
              profit: '10.00',
              profitBps: 526,
              weightBps: 3333,
            },
            expect.objectContaining({
              ticker: 'USD1',
              currency: 'USD',
              value: '50.00',
              weightBps: null,
            }),
          ],
        },
      ]);
    });

    it('uses only the latest pie day, names unknown tickers by ticker and drops empty remainders', async () => {
      const acc = await seeded();
      await pie(a, acc, 'Old', '2026-10-01', [
        { ticker: 'EXA_EQ', quantity: '4', invested: 1, value: 1 },
      ]);
      await pie(a, acc, 'All', '2026-10-02', [
        { ticker: 'EXA_EQ', quantity: '4', invested: 36_000, value: 40_000 },
        { ticker: 'EXB_EQ', quantity: '2.5', invested: 20_000, value: 21_000 },
        { ticker: 'SOLD_EQ', quantity: '1', invested: 500, value: 600 },
      ]);
      const groups = (await listHoldings(a, acc)).groups!;
      expect(groups.map((g) => g.name)).toEqual(['All', null]);
      expect(groups[0]!.items.find((i) => i.ticker === 'SOLD_EQ')).toMatchObject({
        name: 'SOLD_EQ',
        isin: null,
      });
      // EXA is fully in the pie and EXB's pie quantity exceeds the position: no remainder.
      expect(groups[1]!.items.map((i) => i.ticker)).toEqual(['USD1']);
      expect(groups[1]).toMatchObject({ value: '0.00', weightBps: 0 });
    });

    it('gives an unknown cost to a remainder whose cost would be negative', async () => {
      const acc = await account(a);
      await snap(a, acc, '2026-10-02', [
        { instrument: 'NEG_EQ', quantity: '3', value: 3_000, cost: 1_000, pl: 2_000 },
      ]);
      await pie(a, acc, 'P', '2026-10-02', [
        { ticker: 'NEG_EQ', quantity: '1', invested: 1_500, value: 1_000 },
      ]);
      const outside = (await listHoldings(a, acc)).groups!.find((g) => g.id === null)!;
      expect(outside.items[0]).toMatchObject({
        quantity: '2',
        value: '20.00',
        cost: null,
        profit: null,
      });
    });

    it('gives an unknown cost to a remainder of a position without cost', async () => {
      const acc = await account(a);
      await snap(a, acc, '2026-10-02', [{ instrument: 'LEG_EQ', quantity: '3', value: 3_000 }]);
      await pie(a, acc, 'P', '2026-10-02', [
        { ticker: 'LEG_EQ', quantity: '1', invested: 900, value: 1_000 },
      ]);
      const outside = (await listHoldings(a, acc)).groups!.find((g) => g.id === null)!;
      expect(outside).toMatchObject({ value: '20.00', cost: null, profit: null, profitBps: null });
      expect(outside.items[0]).toMatchObject({ quantity: '2', value: '20.00', cost: null });
    });
  });

  it('is readable by viewers and isolated per household', async () => {
    const acc = await account(a);
    await snap(a, acc, '2026-10-02', [{ instrument: 'X', value: 100 }]);
    expect((await listHoldings(withRole(a, 'viewer'), acc)).items).toHaveLength(1);
    const b = await t.household();
    await expect(listHoldings(b, acc)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listHoldings(a, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(listHoldings(a, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('listAccountBuckets', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
  });
  afterAll(() => t.close());

  const account = async (name: string) => {
    const [acc] = await t.owner
      .insert(financialAccount)
      .values({ householdId: a.householdId, name, type: 'investment', currency: 'EUR' })
      .returning({ id: financialAccount.id });
    return acc!.id;
  };

  it('returns the account pies ordered by name, flagging removed ones', async () => {
    const acc = await account('Broker');
    const other = await account('Other broker');
    const bucket = (accountId: string, name: string, removedAt: Date | null = null) => ({
      householdId: a.householdId,
      accountId,
      provider: 'trading212',
      externalId: `ext-${name}`,
      name,
      removedAt,
    });
    const rows = await t.owner
      .insert(investmentBucket)
      .values([
        bucket(acc, 'Zeta'),
        bucket(acc, 'Alpha'),
        bucket(acc, 'Old', new Date('2026-10-01T00:00:00Z')),
        bucket(other, 'Elsewhere'),
      ])
      .returning({ id: investmentBucket.id, name: investmentBucket.name });
    const id = (n: string) => rows.find((r) => r.name === n)!.id;
    expect(await listAccountBuckets(a, acc)).toEqual([
      { id: id('Alpha'), name: 'Alpha', removed: false },
      { id: id('Old'), name: 'Old', removed: true },
      { id: id('Zeta'), name: 'Zeta', removed: false },
    ]);
  });

  it('is empty without pies and rejects an unknown account', async () => {
    const acc = await account('Empty');
    expect(await listAccountBuckets(a, acc)).toEqual([]);
    await expect(listAccountBuckets(a, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
