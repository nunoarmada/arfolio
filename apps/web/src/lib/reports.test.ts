import { describe, expect, it } from 'vitest';
import {
  actionState,
  anomalyLink,
  buildListRows,
  decimalToMinor,
  isClosedMonth,
  isRecentMonth,
  isTooOld,
  lastClosedMonth,
  monthBounds,
  REPORT_BACK,
  toAnomalyDto,
  type AnomalyDto,
} from './reports';

const TODAY = '2026-10-24';

describe('months', () => {
  it('finds the last closed month, across a year', () => {
    expect(lastClosedMonth(TODAY)).toBe('2026-09');
    expect(lastClosedMonth('2026-01-03')).toBe('2025-12');
  });
  it('accepts only well-formed months that have ended', () => {
    expect(isClosedMonth('2026-09', TODAY)).toBe(true);
    expect(isClosedMonth('2026-10', TODAY)).toBe(false);
    expect(isClosedMonth('2026-11', TODAY)).toBe(false);
    expect(isClosedMonth('2026-13', TODAY)).toBe(false);
    expect(isClosedMonth('2026-9', TODAY)).toBe(false);
    expect(isClosedMonth('../x', TODAY)).toBe(false);
  });
  it('knows a month is older than 24 months', () => {
    expect(isTooOld('2024-10', TODAY)).toBe(false);
    expect(isTooOld('2024-09', TODAY)).toBe(true);
  });
  it('gives the bounds of a month', () => {
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('decimalToMinor', () => {
  it('converts exactly, for any currency digits', () => {
    expect(decimalToMinor('1234.56', 'EUR')).toBe(123456);
    expect(decimalToMinor('-0.05', 'EUR')).toBe(-5);
    expect(decimalToMinor('12', 'EUR')).toBe(1200);
    expect(decimalToMinor('1234', 'JPY')).toBe(1234);
    expect(decimalToMinor('0.1', 'EUR')).toBe(10);
  });
  it('refuses what is not a decimal', () => {
    expect(() => decimalToMinor('abc', 'EUR')).toThrow();
    expect(() => decimalToMinor('99999999999999999999.00', 'EUR')).toThrow();
  });
});

describe('buildListRows', () => {
  it('adds the last three closed months without a report, newest first', () => {
    const rows = buildListRows([{ month: '2026-08', status: 'ready' }], TODAY, true);
    expect(rows).toEqual([
      { month: '2026-09', status: 'none' },
      { month: '2026-08', status: 'ready' },
      { month: '2026-07', status: 'none' },
    ]);
  });
  it('keeps stored reports older than that, and adds nothing on a later page', () => {
    const stored = [
      { month: '2026-05', status: 'failed' as const },
      { month: '2026-09', status: 'pending' as const },
    ];
    expect(buildListRows(stored, TODAY, true).map((r) => r.month)).toEqual([
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-05',
    ]);
    expect(buildListRows(stored, TODAY, false).map((r) => r.month)).toEqual(['2026-09', '2026-05']);
  });
  it('knows which months count as recent', () => {
    expect(isRecentMonth('2026-09', TODAY)).toBe(true);
    expect(isRecentMonth('2026-07', TODAY)).toBe(true);
    expect(isRecentMonth('2026-06', TODAY)).toBe(false);
    expect(isRecentMonth('2026-10', TODAY)).toBe(false);
  });
});

describe('actionState', () => {
  const base = {
    role: 'owner' as const,
    aiAvailable: true,
    aiEnabled: true,
    month: '2026-09',
    lastClosed: '2026-09',
    status: 'none' as const,
    regenerations: 0,
    maxRegenerations: 3,
  };
  it('allows owners and members on the last closed month', () => {
    expect(actionState(base)).toEqual({ allowed: true, left: 3, limitReached: false });
    expect(actionState({ ...base, role: 'member' }).allowed).toBe(true);
  });
  it('never for a viewer, an older month, AI off, no key or a pending report', () => {
    expect(actionState({ ...base, role: 'viewer' }).allowed).toBe(false);
    expect(actionState({ ...base, month: '2026-08' }).allowed).toBe(false);
    expect(actionState({ ...base, aiEnabled: false }).allowed).toBe(false);
    expect(actionState({ ...base, aiAvailable: false }).allowed).toBe(false);
    expect(actionState({ ...base, status: 'pending' }).allowed).toBe(false);
  });
  it('counts regenerations left and flags the limit', () => {
    expect(actionState({ ...base, status: 'ready', regenerations: 2 })).toEqual({
      allowed: true,
      left: 1,
      limitReached: false,
    });
    expect(actionState({ ...base, status: 'ready', regenerations: 3 })).toMatchObject({
      left: 0,
      limitReached: true,
    });
  });
});

describe('anomalies', () => {
  it('converts every amount to minor units', () => {
    expect(
      toAnomalyDto(
        { type: 'budget_overrun', lineId: 'l', name: 'Food', actual: '250.50', planned: '200.00' },
        'EUR',
      ),
    ).toEqual({ type: 'budget_overrun', lineId: 'l', name: 'Food', actual: 25050, planned: 20000 });
    expect(
      toAnomalyDto(
        { type: 'recurring_price_change', name: 'N', before: '9.99', after: '12' },
        'EUR',
      ),
    ).toMatchObject({ before: 999, after: 1200 });
  });

  const spike: AnomalyDto = {
    type: 'category_spike',
    categoryId: 'c1',
    name: 'Food',
    amount: 1,
    baseline: 1,
  };
  it('links a spike to that month, that category, spending only', () => {
    const link = anomalyLink(spike, '2026-09', 'member')!;
    expect(link.kind).toBe('movements');
    const params = new URL(link.href, 'http://x').searchParams;
    expect(params.get('from')).toBe('2026-09-01');
    expect(params.get('to')).toBe('2026-09-30');
    expect(params.getAll('category')).toEqual(['c1']);
  });
  it('narrows a large transaction to its category when the report carries it', () => {
    const link = anomalyLink(
      {
        type: 'large_transaction',
        categoryId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
        categoryName: 'X',
        amount: 1,
        date: '2026-09-14',
      },
      '2026-09',
      'viewer',
    )!;
    const params = new URL(link.href, 'http://x').searchParams;
    expect(params.getAll('category')).toEqual(['0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f']);
    expect([params.get('from'), params.get('to'), params.get('type')]).toEqual([
      '2026-09-14',
      '2026-09-14',
      'out',
    ]);
  });
  it('links a large transaction to its day', () => {
    const link = anomalyLink(
      { type: 'large_transaction', categoryName: 'X', amount: 1, date: '2026-09-14' },
      '2026-09',
      'viewer',
    )!;
    const params = new URL(link.href, 'http://x').searchParams;
    expect([params.get('from'), params.get('to')]).toEqual(['2026-09-14', '2026-09-14']);
  });
  it('sends a line to its editor with a way back, but not for a viewer', () => {
    const over: AnomalyDto = {
      type: 'budget_overrun',
      lineId: 'abc',
      name: 'N',
      actual: 2,
      planned: 1,
    };
    const link = anomalyLink(over, '2026-09', 'owner')!;
    expect(link.href).toBe('/budget/lines/abc?back=%2Finsights%2Freports%2F2026-09');
    expect(REPORT_BACK.test(decodeURIComponent(link.href.split('back=')[1]!))).toBe(true);
    expect(anomalyLink(over, '2026-09', 'viewer')).toBeNull();
  });
  it('sends recurring changes to the subscriptions', () => {
    expect(
      anomalyLink(
        { type: 'new_recurring', name: 'N', amount: 1, cadence: 'monthly' },
        '2026-09',
        'viewer',
      ),
    ).toEqual({ kind: 'subscriptions', href: '/budget/subscriptions' });
  });
});

describe('REPORT_BACK', () => {
  it('only matches one report page', () => {
    expect(REPORT_BACK.test('/insights/reports/2026-09')).toBe(true);
    expect(REPORT_BACK.test('/insights/reports/2026-09/x')).toBe(false);
    expect(REPORT_BACK.test('//evil.com')).toBe(false);
  });
});
