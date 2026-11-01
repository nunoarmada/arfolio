import { describe, expect, it } from 'vitest';
import {
  aiStatus,
  assetCurrent,
  changeFromRows,
  currentAiEstimate,
  liabilityCurrent,
  sourceLinks,
  type AccountFigure,
} from './net-worth-derive';

const row = (month: string, net: number, change: number | null) => ({
  month,
  assets: net,
  liabilities: 0,
  net,
  change,
});

describe('changeFromRows', () => {
  it('is unknown without history, first with one month', () => {
    expect(changeFromRows(null)).toEqual({ kind: 'unknown' });
    expect(changeFromRows([row('2026-10-01', 5, null)])).toEqual({ kind: 'first' });
  });
  it('compares with the latest earlier month that has a record', () => {
    expect(changeFromRows([row('2026-07-01', 1, null), row('2026-10-01', 11, 10)])).toEqual({
      kind: 'up',
      amount: 10,
      prevMonth: '2026-07-01',
    });
    expect(changeFromRows([row('2026-09-01', 11, null), row('2026-10-01', 6, -5)])).toEqual({
      kind: 'down',
      amount: 5,
      prevMonth: '2026-09-01',
    });
    expect(changeFromRows([row('2026-09-01', 6, null), row('2026-10-01', 6, 0)])).toEqual({
      kind: 'flat',
      amount: 0,
      prevMonth: '2026-09-01',
    });
  });
});

const entry = (asOf: string, amount: number, method: string) => ({
  id: asOf,
  asOf,
  amount,
  method,
  note: null,
});

describe('assetCurrent', () => {
  const today = '2026-10-22';
  it('has no value without a valuation', () => {
    expect(
      assetCurrent({
        accountId: null,
        accountItem: null,
        item: undefined,
        entries: [],
        today,
        depreciationBps: null,
      }),
    ).toEqual({
      current: { hasValue: false, amount: 0, asOf: null, method: null },
      estimateFrom: null,
    });
  });
  it('takes the amount from the item and the method from the latest real valuation', () => {
    const r = assetCurrent({
      accountId: null,
      accountItem: null,
      item: { hasValue: true, amount: 8605, asOf: '2025-10-22' },
      entries: [entry('2026-01-01', 1, 'depreciation'), entry('2025-10-22', 10000, 'import')],
      today,
      depreciationBps: 1500,
    });
    expect(r.current).toEqual({
      hasValue: true,
      amount: 8605,
      asOf: '2025-10-22',
      method: 'import',
    });
    expect(r.estimateFrom).toEqual({ amount: 10000, asOf: '2025-10-22' });
  });
  it('ignores a future valuation when picking the base', () => {
    const r = assetCurrent({
      accountId: null,
      accountItem: null,
      item: { hasValue: true, amount: 5, asOf: '2026-01-01' },
      entries: [entry('2027-01-01', 9, 'manual'), entry('2026-01-01', 5, 'manual')],
      today,
      depreciationBps: null,
    });
    expect(r.current.method).toBe('manual');
    expect(r.estimateFrom).toBeNull();
  });
  it('takes a linked asset from its account, signed by the side it is counted on', () => {
    const acct = (side: 'asset' | 'liability'): AccountFigure => ({
      side,
      amount: 57,
      asOf: '2026-10-01',
    });
    expect(
      assetCurrent({
        accountId: 'a',
        accountItem: acct('asset'),
        item: undefined,
        entries: [],
        today,
        depreciationBps: 1000,
      }),
    ).toEqual({
      current: { hasValue: true, amount: 57, asOf: '2026-10-01', method: 'account' },
      estimateFrom: null,
    });
    expect(
      assetCurrent({
        accountId: 'a',
        accountItem: acct('liability'),
        item: undefined,
        entries: [],
        today,
        depreciationBps: null,
      }).current.amount,
    ).toBe(-57);
  });
  it('has no value when the linked account is not counted', () => {
    expect(
      assetCurrent({
        accountId: 'a',
        accountItem: null,
        item: undefined,
        entries: [],
        today,
        depreciationBps: null,
      }).current.hasValue,
    ).toBe(false);
  });
});

describe('liabilityCurrent', () => {
  const today = '2026-10-22';
  const base = { accountId: null, accountItem: null, entries: [], today, plan: null };
  it('uses the account for a linked liability, captioned as the account', () => {
    expect(
      liabilityCurrent({
        ...base,
        accountId: 'a',
        accountItem: { side: 'liability', amount: 900, asOf: '2026-10-01' },
        item: undefined,
      }),
    ).toMatchObject({
      current: { hasValue: true, amount: 900, caption: { kind: 'account' } },
      real: 900,
    });
  });
  it('captions a recorded balance by its source', () => {
    const item = { hasValue: true, amount: 700, asOf: '2026-10-01' };
    const mk = (method: string) =>
      liabilityCurrent({ ...base, item, entries: [entry('2026-10-01', 700, method)] });
    expect(mk('connector').current.caption).toEqual({ kind: 'bank', asOf: '2026-10-01' });
    expect(mk('manual').current.caption).toEqual({ kind: 'recorded', asOf: '2026-10-01' });
    expect(mk('manual').real).toBe(700);
  });
  it('falls back to the plan, then to the original amount, with nothing recorded', () => {
    const item = { hasValue: true, amount: 500, asOf: null };
    expect(liabilityCurrent({ ...base, item, plan: { planBalance: 500 } })).toMatchObject({
      current: { caption: { kind: 'schedule' } },
      real: null,
    });
    expect(liabilityCurrent({ ...base, item }).current.caption).toEqual({ kind: 'principal' });
  });
  it('has no value without an item', () => {
    expect(liabilityCurrent({ ...base, item: undefined })).toMatchObject({
      current: { hasValue: false, amount: 0, caption: { kind: 'none' } },
      real: null,
    });
  });
  it('flags a divergence only from a recorded balance', () => {
    const item = { hasValue: true, amount: 15_000_000, asOf: '2026-10-01' };
    const r = liabilityCurrent({
      ...base,
      item,
      entries: [entry('2026-10-01', 15_000_000, 'manual')],
      plan: { planBalance: 22_500_000 },
    });
    expect(r.divergence).toEqual({ real: 15_000_000, plan: 22_500_000 });
    expect(
      liabilityCurrent({
        ...base,
        item: { hasValue: true, amount: 22_500_000, asOf: null },
        plan: { planBalance: 22_500_000 },
      }).divergence,
    ).toBeNull();
  });
});

describe('AI valuations', () => {
  const today = '2026-10-22';
  const estimate = {
    low: 18000000,
    high: 22000000,
    confidence: 'medium' as const,
    sources: [{ title: 'Idealista', url: 'https://www.idealista.pt/x' }],
  };
  const ai = (asOf: string, amount: number, over: Record<string, unknown> = {}) => ({
    asOf,
    amount,
    method: 'ai',
    note: 'Comparable flats nearby.',
    estimate,
    ...over,
  });

  it('is the current value source, with no depreciation base on an asset without a rate', () => {
    const r = assetCurrent({
      accountId: null,
      accountItem: null,
      item: { hasValue: true, amount: 20000000, asOf: '2026-10-01' },
      entries: [ai('2026-10-01', 20000000)],
      today,
      depreciationBps: null,
    });
    expect(r.current.method).toBe('ai');
    expect(r.estimateFrom).toBeNull();
  });

  it('exposes the range, confidence, sources and rationale of the current AI value', () => {
    expect(currentAiEstimate({ entries: [ai('2026-10-01', 20000000)], today })).toEqual({
      asOf: '2026-10-01',
      ...estimate,
      rationale: 'Comparable flats nearby.',
    });
  });

  it('has no estimate when a newer manual value replaced the AI one', () => {
    expect(
      currentAiEstimate({
        entries: [entry('2026-10-10', 1, 'manual'), ai('2026-10-01', 20000000)],
        today,
      }),
    ).toBeNull();
  });

  it('skips future rows and depreciation rows when finding the current value', () => {
    expect(
      currentAiEstimate({
        entries: [
          ai('2027-01-01', 1),
          entry('2026-10-15', 1, 'depreciation'),
          ai('2026-10-01', 20000000),
        ],
        today,
      })?.asOf,
    ).toBe('2026-10-01');
  });

  it('has no estimate for an AI row stored without one', () => {
    expect(
      currentAiEstimate({ entries: [ai('2026-10-01', 5, { estimate: null })], today }),
    ).toBeNull();
  });

  it('has a null rationale when the row has no note', () => {
    expect(
      currentAiEstimate({ entries: [ai('2026-10-01', 5, { note: null })], today })?.rationale,
    ).toBeNull();
  });
});

describe('aiStatus', () => {
  const ready = { eligible: true, missing: [] as string[] };
  const base = {
    aiValuation: true,
    householdAiEnabled: true,
    readiness: ready,
    aiRequestedAt: null as string | null,
    aiLastError: null as string | null,
    hasValue: true,
  };
  it('says nothing when AI is off for the asset', () => {
    expect(aiStatus({ ...base, aiValuation: false, aiLastError: 'api_error' })).toBeNull();
  });
  it('reports the household switch first: nothing runs without it', () => {
    expect(
      aiStatus({
        ...base,
        householdAiEnabled: false,
        readiness: { eligible: false, missing: ['areaM2'] },
        aiRequestedAt: '2026-10-31T10:00:00Z',
      }),
    ).toEqual({ kind: 'householdOff' });
  });
  it('lists the missing fields before a pending request', () => {
    expect(
      aiStatus({
        ...base,
        readiness: { eligible: false, missing: ['areaM2', 'municipality'] },
        aiRequestedAt: '2026-10-31T10:00:00Z',
      }),
    ).toEqual({ kind: 'missing', fields: ['areaM2', 'municipality'] });
  });
  it('is queued while a request waits', () => {
    expect(aiStatus({ ...base, aiRequestedAt: '2026-10-31T10:00:00Z' })).toEqual({
      kind: 'queued',
    });
  });
  it('carries the last error code', () => {
    expect(aiStatus({ ...base, aiLastError: 'insufficient_data' })).toEqual({
      kind: 'error',
      code: 'insufficient_data',
    });
  });
  it('falls back to the monthly note, or the first-estimate note without a value', () => {
    expect(aiStatus(base)).toEqual({ kind: 'monthly' });
    expect(aiStatus({ ...base, hasValue: false })).toEqual({ kind: 'first' });
  });
});

describe('sourceLinks', () => {
  it('keeps http(s) links, always with their host and with the title when there is one', () => {
    expect(
      sourceLinks([
        { title: 'T2 em Arroios', url: 'https://www.idealista.pt/imovel/1' },
        { title: '  ', url: 'http://imovirtual.com/x' },
        { title: 'www.supercasa.pt', url: 'https://www.supercasa.pt/y' },
      ]),
    ).toEqual([
      { href: 'https://www.idealista.pt/imovel/1', title: 'T2 em Arroios', host: 'idealista.pt' },
      { href: 'http://imovirtual.com/x', title: null, host: 'imovirtual.com' },
      { href: 'https://www.supercasa.pt/y', title: null, host: 'supercasa.pt' },
    ]);
  });
  it('drops anything that is not a web link', () => {
    expect(
      sourceLinks([
        { title: 'x', url: 'javascript:alert(1)' },
        { title: 'y', url: 'not a url' },
        { title: 'z', url: 'data:text/html,hi' },
      ]),
    ).toEqual([]);
  });
});
