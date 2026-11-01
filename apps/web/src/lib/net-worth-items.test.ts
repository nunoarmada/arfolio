import { describe, expect, it } from 'vitest';
import {
  accountFigure,
  buildGroups,
  ASSET_GROUP_ORDER,
  LIABILITY_GROUP_ORDER,
  type NwItem,
} from './net-worth-items';

const item = (over: Partial<NwItem> & Pick<NwItem, 'refId' | 'name'>): NwItem => ({
  side: 'asset',
  kind: 'cash',
  amount: 0,
  currency: 'EUR',
  source: 'asset',
  linked: false,
  viaAccountId: null,
  foreignCurrency: false,
  asOf: null,
  hasValue: true,
  ...over,
});

const base = {
  byKind: {} as Record<string, number>,
  assets: [] as Array<{ id: string; depreciationBpsPerYear: number | null }>,
  liabilities: [] as Array<{
    id: string;
    principal: number | null;
    annualRateBps: number | null;
    termMonths: number | null;
    startDate: string | null;
  }>,
  latest: [] as Array<{
    refId: string;
    side: 'asset' | 'liability';
    asOf: string | null;
    value: number | null;
    source: string | null;
  }>,
};

describe('group order', () => {
  it('follows the design: property first for assets, mortgages first for liabilities', () => {
    expect(ASSET_GROUP_ORDER).toEqual(['real_estate', 'investment', 'cash', 'vehicle', 'other']);
    expect(LIABILITY_GROUP_ORDER).toEqual(['mortgage', 'loan', 'card', 'debt', 'other']);
  });
});

describe('buildGroups', () => {
  it('groups by kind in the fixed order and leaves empty groups out', () => {
    const { assets, liabilities } = buildGroups({
      ...base,
      items: [
        item({ refId: 'a1', name: 'Carro', kind: 'vehicle', amount: 800000, asOf: '2026-09-30' }),
        item({
          refId: 'a2',
          name: 'Casa',
          kind: 'real_estate',
          amount: 30000000,
          asOf: '2026-09-30',
        }),
        item({ refId: 'c1', name: 'Conta', kind: 'cash', amount: 1000, source: 'account' }),
      ],
      byKind: { 'asset:vehicle': 800000, 'asset:real_estate': 30000000, 'asset:cash': 1000 },
      accountNames: new Map(),
    });
    expect(assets.map((g) => g.kind)).toEqual(['real_estate', 'cash', 'vehicle']);
    expect(assets[0]!.subtotal).toBe(30000000);
    expect(liabilities).toEqual([]);
  });

  it('shows a linked record once, as the account amount under the record name and kind', () => {
    const { liabilities, assets } = buildGroups({
      ...base,
      items: [
        // the account row carries the record's kind (the services rewrite it)
        item({
          refId: 'acc1',
          name: 'Conta crédito',
          side: 'liability',
          kind: 'mortgage',
          amount: 18000000,
          source: 'account',
          asOf: '2026-10-01',
        }),
        item({
          refId: 'l1',
          name: 'Hipoteca casa',
          side: 'liability',
          kind: 'mortgage',
          source: 'liability',
          linked: true,
          viaAccountId: 'acc1',
        }),
      ],
      byKind: { 'liability:mortgage': 18000000 },
      accountNames: new Map([['acc1', 'Conta crédito']]),
    });
    expect(assets).toEqual([]);
    expect(liabilities).toHaveLength(1);
    const rows = liabilities[0]!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Hipoteca casa',
      href: '/net-worth/liabilities/l1',
      amount: 18000000,
      hasValue: true,
      subtitle: { kind: 'via', account: 'Conta crédito', asOf: '2026-10-01' },
    });
  });

  it('links an account to its asset record the same way', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({
          refId: 'acc9',
          name: 'Corretora',
          kind: 'investment',
          amount: 5000,
          source: 'account',
        }),
        item({
          refId: 'a9',
          name: 'Carteira',
          kind: 'investment',
          linked: true,
          viaAccountId: 'acc9',
        }),
      ],
      byKind: { 'asset:investment': 5000 },
      accountNames: new Map([['acc9', 'Corretora']]),
    });
    expect(assets[0]!.rows.map((r) => [r.title, r.href])).toEqual([
      ['Carteira', '/net-worth/assets/a9'],
    ]);
  });

  it('shows an asset linked to an overdrawn account once, where the account is counted', () => {
    const { assets, liabilities } = buildGroups({
      ...base,
      items: [
        // the account is negative now, so the services count it as a liability
        item({
          refId: 'acc1',
          name: 'Conta corrente',
          side: 'liability',
          kind: 'debt',
          amount: 5700,
          source: 'account',
          asOf: '2026-10-01',
        }),
        item({ refId: 'a1', name: 'Carteira', kind: 'cash', linked: true, viaAccountId: 'acc1' }),
      ],
      byKind: { 'liability:debt': 5700 },
      accountNames: new Map([['acc1', 'Conta corrente']]),
    });
    expect(assets).toEqual([]);
    expect(liabilities).toHaveLength(1);
    expect(liabilities[0]!.kind).toBe('debt');
    expect(liabilities[0]!.rows).toHaveLength(1);
    expect(liabilities[0]!.rows[0]).toMatchObject({
      title: 'Carteira',
      href: '/net-worth/assets/a1',
      amount: 5700,
      hasValue: true,
    });
  });

  it('lists a linked record whose account is not counted as having no value', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({
          refId: 'a9',
          name: 'Carteira',
          kind: 'investment',
          linked: true,
          viaAccountId: 'gone',
        }),
      ],
      accountNames: new Map([['gone', 'Corretora']]),
    });
    expect(assets[0]!.rows[0]).toMatchObject({
      hasValue: false,
      subtitle: { kind: 'via', account: 'Corretora', asOf: null },
    });
  });

  it('links a plain account to its own page', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({
          refId: 'acc1',
          name: 'Conta à ordem',
          amount: 123,
          source: 'account',
          asOf: '2026-10-02',
        }),
      ],
      byKind: { 'asset:cash': 123 },
      accountNames: new Map(),
    });
    expect(assets[0]!.rows[0]).toMatchObject({
      href: '/accounts/acc1',
      subtitle: { kind: 'account', asOf: '2026-10-02' },
    });
  });

  it('shows an investment account split in two: its invested part and its cash, keys unique', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({ refId: 't212', name: 'T212', amount: 1000, source: 'account', kind: 'investment' }),
        item({ refId: 't212', name: 'T212', amount: 500, source: 'account', kind: 'cash' }),
      ],
      byKind: { 'asset:investment': 1000, 'asset:cash': 500 },
      accountNames: new Map(),
    });
    expect(assets.map((g) => [g.kind, g.subtotal, g.rows.map((r) => r.amount)])).toEqual([
      ['investment', 1000, [1000]],
      ['cash', 500, [500]],
    ]);
    const keys = assets.flatMap((g) => g.rows.map((r) => r.key));
    expect(new Set(keys).size).toBe(2);
  });

  it('keeps items with no value in the list, last in their group, outside the subtotal', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({ refId: 'a1', name: 'Apartamento', kind: 'real_estate', hasValue: false }),
        item({
          refId: 'a2',
          name: 'Terreno',
          kind: 'real_estate',
          amount: 1000,
          asOf: '2026-01-01',
        }),
      ],
      byKind: { 'asset:real_estate': 1000 },
      accountNames: new Map(),
    });
    const group = assets[0]!;
    expect(group.subtotal).toBe(1000);
    expect(group.rows.map((r) => [r.title, r.hasValue])).toEqual([
      ['Terreno', true],
      ['Apartamento', false],
    ]);
    expect(group.rows[1]!.subtitle).toEqual({ kind: 'noValue' });
  });

  it('flags other-currency items, sorts them last and never sums them', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({
          refId: 'a1',
          name: 'Conta USD',
          currency: 'USD',
          foreignCurrency: true,
          amount: 9_000_000,
          source: 'account',
        }),
        item({ refId: 'a2', name: 'Poupança', amount: 100, source: 'account' }),
      ],
      byKind: { 'asset:cash': 100 },
      accountNames: new Map(),
    });
    expect(assets[0]!.subtotal).toBe(100);
    expect(assets[0]!.rows.map((r) => [r.title, r.foreign, r.currency])).toEqual([
      ['Poupança', false, 'EUR'],
      ['Conta USD', true, 'USD'],
    ]);
  });

  it('keeps two entries of one account apart (balance and a foreign position)', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({ refId: 'acc', name: 'T212', kind: 'investment', amount: 100, source: 'account' }),
        item({
          refId: 'acc',
          name: 'T212',
          kind: 'investment',
          amount: 50,
          source: 'account',
          currency: 'USD',
          foreignCurrency: true,
        }),
      ],
      byKind: { 'asset:investment': 100 },
      accountNames: new Map(),
    });
    const keys = assets[0]!.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('sorts by amount, largest first', () => {
    const { assets } = buildGroups({
      ...base,
      items: [
        item({ refId: 'a', name: 'Pequena', amount: 10, source: 'account' }),
        item({ refId: 'b', name: 'Grande', amount: 1000, source: 'account' }),
      ],
      byKind: { 'asset:cash': 1010 },
      accountNames: new Map(),
    });
    expect(assets[0]!.rows.map((r) => r.title)).toEqual(['Grande', 'Pequena']);
  });

  describe('subtitles', () => {
    const asset = (
      over: Partial<NwItem>,
      rec = { depreciationBpsPerYear: null as number | null },
      source: string | null = 'manual',
    ) =>
      buildGroups({
        ...base,
        items: [item({ refId: 'a1', name: 'X', amount: 5, asOf: '2026-09-30', ...over })],
        assets: [{ id: 'a1', ...rec }],
        latest: [{ refId: 'a1', side: 'asset', asOf: '2026-09-30', value: 5, source }],
        byKind: { 'asset:cash': 5 },
        accountNames: new Map(),
      }).assets[0]!.rows[0]!.subtitle;

    it('names manual, imported and bank valuations with their date', () => {
      expect(asset({})).toEqual({ kind: 'manual', asOf: '2026-09-30' });
      expect(asset({}, undefined, 'import')).toEqual({ kind: 'import', asOf: '2026-09-30' });
      expect(asset({}, undefined, 'connector')).toEqual({ kind: 'connector', asOf: '2026-09-30' });
    });
    it('names an AI valuation with its date', () => {
      expect(asset({ kind: 'real_estate' }, undefined, 'ai')).toEqual({
        kind: 'ai',
        asOf: '2026-09-30',
      });
    });
    it('prefers the depreciation note for a depreciating asset', () => {
      expect(asset({ kind: 'vehicle' }, { depreciationBpsPerYear: 1500 })).toEqual({
        kind: 'depreciation',
        bps: 1500,
      });
    });

    const liability = (
      over: Partial<NwItem>,
      rec: Partial<(typeof base.liabilities)[number]>,
      source: string | null,
    ) =>
      buildGroups({
        ...base,
        items: [
          item({
            refId: 'l1',
            name: 'Y',
            side: 'liability',
            kind: 'loan',
            source: 'liability',
            amount: 5,
            ...over,
          }),
        ],
        liabilities: [
          {
            id: 'l1',
            principal: null,
            annualRateBps: null,
            termMonths: null,
            startDate: null,
            ...rec,
          },
        ],
        latest: source
          ? [{ refId: 'l1', side: 'liability', asOf: over.asOf ?? null, value: 5, source }]
          : [],
        byKind: { 'liability:loan': 5 },
        accountNames: new Map(),
      }).liabilities[0]!.rows[0]!.subtitle;

    it('describes a recorded balance by its source', () => {
      expect(liability({ asOf: '2026-09-30' }, {}, 'manual')).toEqual({
        kind: 'manual',
        asOf: '2026-09-30',
      });
      expect(liability({ asOf: '2026-09-30' }, {}, 'connector')).toEqual({
        kind: 'connector',
        asOf: '2026-09-30',
      });
      expect(liability({ asOf: '2026-09-30' }, {}, 'schedule')).toEqual({ kind: 'schedule' });
    });
    it('falls back to the schedule, then to the original amount', () => {
      const sched = { principal: 100, annualRateBps: 300, termMonths: 12, startDate: '2026-01-01' };
      expect(liability({ asOf: null }, sched, null)).toEqual({ kind: 'schedule' });
      expect(liability({ asOf: null }, { principal: 100 }, null)).toEqual({ kind: 'principal' });
    });
  });
});

describe('linked credits', () => {
  const house = (over: Partial<NwItem> = {}) =>
    item({
      refId: 'h1',
      name: 'Casa',
      kind: 'real_estate',
      amount: 30000000,
      asOf: '2026-09-30',
      ...over,
    });
  const credit = (id: string, name: string, amount: number, over: Partial<NwItem> = {}) =>
    item({
      refId: id,
      name,
      side: 'liability',
      kind: 'loan',
      source: 'liability',
      amount,
      asOf: '2026-09-30',
      ...over,
    });
  const records = (links: Record<string, string>) =>
    Object.entries(links).map(([id, assetId]) => ({
      id,
      principal: null,
      annualRateBps: null,
      termMonths: null,
      startDate: null,
      assetId,
    }));
  const build = (items: NwItem[], links: Record<string, string>) =>
    buildGroups({
      ...base,
      assets: [{ id: 'h1', name: 'Casa', depreciationBpsPerYear: null }],
      liabilities: records(links),
      items,
      byKind: { 'asset:real_estate': 30000000, 'liability:loan': 0 },
      accountNames: new Map(),
    });

  it('nests linked unsettled liabilities under their asset with equity = value − balances', () => {
    const { assets, liabilities } = build(
      [house(), credit('l1', 'Banco A', 10000000), credit('l2', 'Banco B', 2000000)],
      { l1: 'h1', l2: 'h1' },
    );
    const row = assets[0]!.rows[0]!;
    expect(row.linkedLiabilities).toEqual([
      { refId: 'l1', name: 'Banco A', amount: 10000000, hasValue: true, foreign: false },
      { refId: 'l2', name: 'Banco B', amount: 2000000, hasValue: true, foreign: false },
    ]);
    expect(row.equity).toBe(18000000);
    // still listed in Passivos, tagged with the asset
    expect(liabilities[0]!.rows.map((r) => [r.refId, r.assetName, r.assetSold])).toEqual([
      ['l1', 'Casa', false],
      ['l2', 'Casa', false],
    ]);
  });

  it('leaves assets without linked credits untouched', () => {
    const { assets } = build([house()], {});
    expect(assets[0]!.rows[0]!.linkedLiabilities).toBeUndefined();
    expect(assets[0]!.rows[0]!.equity).toBeUndefined();
  });

  it('equity is null when a liability has no value or another currency', () => {
    const noValue = build([house(), credit('l1', 'Banco A', 0, { hasValue: false })], {
      l1: 'h1',
    }).assets[0]!.rows[0]!;
    expect(noValue.equity).toBeNull();
    expect(noValue.linkedLiabilities).toHaveLength(1);
    const foreign = build(
      [house(), credit('l1', 'Banco A', 5, { currency: 'USD', foreignCurrency: true })],
      { l1: 'h1' },
    ).assets[0]!.rows[0]!;
    expect(foreign.equity).toBeNull();
    const noAssetValue = build([house({ hasValue: false, amount: 0 }), credit('l1', 'A', 5)], {
      l1: 'h1',
    }).assets[0]!.rows[0]!;
    expect(noAssetValue.equity).toBeNull();
  });

  it('keeps the Passivos subtotal and row count unchanged by nesting', () => {
    const items = [house(), credit('l1', 'Banco A', 10000000)];
    const nested = build(items, { l1: 'h1' }).liabilities;
    const plain = build(items, {}).liabilities;
    expect(nested.map((g) => [g.kind, g.subtotal, g.rows.length])).toEqual(
      plain.map((g) => [g.kind, g.subtotal, g.rows.length]),
    );
  });

  it('an unsettled liability of a sold asset stays ungrouped with assetSold', () => {
    const { assets, liabilities } = buildGroups({
      ...base,
      assets: [{ id: 'h1', name: 'Casa', depreciationBpsPerYear: null, disposedOn: '2026-10-01' }],
      liabilities: records({ l1: 'h1' }),
      items: [credit('l1', 'Banco A', 10000000)],
      byKind: { 'liability:loan': 10000000 },
      accountNames: new Map(),
    });
    expect(assets).toEqual([]);
    expect(liabilities[0]!.rows[0]).toMatchObject({ assetName: 'Casa', assetSold: true });
  });
  it('tells a written-off asset from a sold one', () => {
    const rowFor = (disposalKind: 'sold' | 'written_off') =>
      buildGroups({
        ...base,
        assets: [
          {
            id: 'h1',
            name: 'Casa',
            depreciationBpsPerYear: null,
            disposedOn: '2026-10-01',
            disposalKind,
          },
        ],
        liabilities: records({ l1: 'h1' }),
        items: [credit('l1', 'Banco A', 10000000)],
        byKind: { 'liability:loan': 10000000 },
        accountNames: new Map(),
      }).liabilities[0]!.rows[0]!;
    expect(rowFor('sold').assetWrittenOff).toBeUndefined();
    expect(rowFor('written_off')).toMatchObject({ assetSold: true, assetWrittenOff: true });
  });
});

describe('accountFigure', () => {
  it('adds up the parts of a split account, leaving foreign positions out', () => {
    const items = [
      item({
        refId: 't212',
        name: 'T212',
        amount: 700,
        source: 'account',
        kind: 'investment',
        asOf: '2026-10-30',
      }),
      item({
        refId: 't212',
        name: 'T212',
        amount: 300,
        source: 'account',
        kind: 'cash',
        asOf: '2026-10-30',
      }),
      item({ refId: 't212', name: 'T212', amount: 50, source: 'account', currency: 'USD' }),
      item({ refId: 'other', name: 'Other', amount: 9, source: 'account' }),
    ];
    expect(accountFigure(items, 't212')).toEqual({
      side: 'asset',
      amount: 1000,
      asOf: '2026-10-30',
    });
    expect(accountFigure(items, 'missing')).toBeNull();
    expect(accountFigure(items, null)).toBeNull();
  });
});
