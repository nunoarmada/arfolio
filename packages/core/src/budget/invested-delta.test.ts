import { describe, expect, it } from 'vitest';
import { investedDelta, type SnapshotDay } from './invested-delta';

const day = (asOf: string, rows: Array<[string, number | null, string?]>): SnapshotDay => ({
  asOf,
  rows: rows.map(([key, investedMinor, currency]) => ({
    key,
    investedMinor,
    currency: currency ?? 'EUR',
  })),
});
const range = { from: '2026-10-01', to: '2026-10-31', today: '2026-11-15' };

describe('investedDelta', () => {
  it('baseline_missing_is_noData', () => {
    const days = [day('2026-10-05', [['A', 1000]])];
    expect(investedDelta(days, ['A'], range, 'EUR')).toEqual({ kind: 'noData' });
  });

  it('delta_is_end_minus_baseline', () => {
    const days = [day('2026-09-30', [['A', 1000]]), day('2026-10-31', [['A', 1450]])];
    expect(investedDelta(days, ['A'], range, 'EUR')).toEqual({
      kind: 'known',
      delta: 450,
      foreignRows: 0,
      endAsOf: '2026-10-31',
    });
  });

  it('sold_out_counts_zero', () => {
    const days = [day('2026-09-30', [['A', 1000]]), day('2026-10-31', [['B', 500]])];
    const r = investedDelta(days, ['A'], range, 'EUR');
    expect(r).toMatchObject({ kind: 'known', delta: -1000 });
  });

  it('null_cost_is_noData', () => {
    const days = [day('2026-09-30', [['A', 1000]]), day('2026-10-31', [['A', null]])];
    expect(investedDelta(days, ['A'], range, 'EUR')).toEqual({ kind: 'noData' });
  });

  it('foreign_rows_counted_not_summed', () => {
    const days = [
      day('2026-09-30', [['A', 1000]]),
      day('2026-10-31', [
        ['A', 1200],
        ['F', 9999, 'USD'],
      ]),
    ];
    expect(investedDelta(days, ['A', 'F'], range, 'EUR')).toEqual({
      kind: 'known',
      delta: 200,
      foreignRows: 1,
      endAsOf: '2026-10-31',
    });
  });

  it('future_month_is_zero', () => {
    const days = [day('2026-09-30', [['A', 1000]])];
    const r = investedDelta(
      days,
      ['A'],
      { from: '2026-12-01', to: '2026-12-31', today: '2026-11-15' },
      'EUR',
    );
    expect(r).toEqual({ kind: 'known', delta: 0, foreignRows: 0, endAsOf: null });
  });

  it('current_month_uses_latest_snapshot_up_to_today', () => {
    const days = [
      day('2026-09-30', [['A', 1000]]),
      day('2026-11-03', [['A', 1300]]),
      day('2026-11-10', [['A', 1700]]),
      day('2026-11-20', [['A', 9000]]),
    ];
    const r = investedDelta(
      days,
      ['A'],
      { from: '2026-11-01', to: '2026-11-30', today: '2026-11-15' },
      'EUR',
    );
    expect(r).toEqual({ kind: 'known', delta: 700, foreignRows: 0, endAsOf: '2026-11-10' });
  });

  describe('baselineGraceDays', () => {
    const grace = { baselineGraceDays: 2 };

    it('uses_earliest_snapshot_within_grace_as_baseline', () => {
      const days = [
        day('2026-10-02', [['A', 1000]]),
        day('2026-10-03', [['A', 1200]]),
        day('2026-10-31', [['A', 1450]]),
      ];
      expect(investedDelta(days, ['A'], range, 'EUR', grace)).toEqual({
        kind: 'known',
        delta: 450,
        foreignRows: 0,
        endAsOf: '2026-10-31',
      });
    });

    it('snapshot_on_day_four_is_still_noData', () => {
      const days = [day('2026-10-04', [['A', 1000]]), day('2026-10-31', [['A', 1450]])];
      expect(investedDelta(days, ['A'], range, 'EUR', grace)).toEqual({ kind: 'noData' });
    });

    it('a_day_before_from_wins_over_grace', () => {
      const days = [
        day('2026-09-30', [['A', 1000]]),
        day('2026-10-02', [['A', 1100]]),
        day('2026-10-31', [['A', 1450]]),
      ];
      expect(investedDelta(days, ['A'], range, 'EUR', grace)).toMatchObject({ delta: 450 });
    });

    it('is_noData_without_the_option', () => {
      const days = [day('2026-10-02', [['A', 1000]]), day('2026-10-31', [['A', 1450]])];
      expect(investedDelta(days, ['A'], range, 'EUR')).toEqual({ kind: 'noData' });
    });

    it('grace_baseline_after_the_end_is_noData', () => {
      const days = [day('2026-10-03', [['A', 1000]])];
      expect(
        investedDelta(
          days,
          ['A'],
          { from: '2026-10-01', to: '2026-10-02', today: '2026-10-31' },
          'EUR',
          grace,
        ),
      ).toEqual({ kind: 'noData' });
    });
  });
});
