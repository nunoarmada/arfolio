import { describe, expect, it } from 'vitest';
import { monthlySeries } from './net-worth-series';

describe('monthlySeries', () => {
  it('carries each value forward month by month up to the current month', () => {
    const rows = monthlySeries(
      [
        { asOf: '2026-08-20', amount: 120 },
        { asOf: '2026-05-10', amount: 100 },
      ],
      '2026-10-01',
      150,
    );
    expect(rows.map((r) => [r.month, r.net])).toEqual([
      ['2026-05-01', 100],
      ['2026-06-01', 100],
      ['2026-07-01', 100],
      ['2026-08-01', 120],
      ['2026-09-01', 120],
      ['2026-10-01', 150],
    ]);
    expect(rows[0]!.change).toBeNull();
    expect(rows.map((r) => r.change)).toEqual([null, 0, 0, 20, 0, 30]);
  });

  it('uses the last value of a month when there are several', () => {
    const rows = monthlySeries(
      [
        { asOf: '2026-09-25', amount: 130 },
        { asOf: '2026-09-02', amount: 110 },
      ],
      '2026-10-01',
      130,
    );
    expect(rows.map((r) => r.net)).toEqual([130, 130]);
  });

  it('has a single row when everything happened this month', () => {
    const rows = monthlySeries([{ asOf: '2026-10-03', amount: 5 }], '2026-10-01', 5);
    expect(rows).toHaveLength(1);
  });

  it('ignores values dated after the current month and is empty without entries', () => {
    expect(monthlySeries([{ asOf: '2027-01-01', amount: 9 }], '2026-10-01', 9)).toEqual([]);
    expect(monthlySeries([], '2026-10-01', 0)).toEqual([]);
  });

  it('puts the amount in net and leaves assets and liabilities at the same figure and zero', () => {
    const [row] = monthlySeries([{ asOf: '2026-10-03', amount: 5 }], '2026-10-01', 5);
    expect(row).toMatchObject({ net: 5, assets: 5, liabilities: 0 });
  });
});
