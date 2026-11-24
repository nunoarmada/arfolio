import { describe, expect, it } from 'vitest';
import { completeMonths, typicalSpend } from '../src/index.js';

describe('completeMonths', () => {
  it('skips the first month when the data starts mid-month', () => {
    expect(completeMonths('2026-08-15', '2026-11-24')).toEqual(['2026-09', '2026-10']);
  });

  it('counts the first month when the data starts on its 1st day', () => {
    expect(completeMonths('2026-08-01', '2026-11-24')).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('is empty without booked data', () => {
    expect(completeMonths(null, '2026-11-24')).toEqual([]);
  });

  it('never includes the current month', () => {
    expect(completeMonths('2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('crosses a year boundary', () => {
    expect(completeMonths('2025-11-01', '2026-02-10')).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('typicalSpend', () => {
  it('reports the median and leaves an outlier month out of min and max', () => {
    expect(typicalSpend([21000, 18000, 24000, 90000])).toEqual({
      median: 22500,
      min: 18000,
      max: 24000,
      months: 4,
      outlierMonths: [3],
    });
  });

  it('handles all-zero months', () => {
    expect(typicalSpend([0, 0, 0])).toEqual({
      median: 0,
      min: 0,
      max: 0,
      months: 3,
      outlierMonths: [],
    });
  });

  it('uses 25% of the median when the deviation is zero', () => {
    // median 100, MAD 0 -> threshold 100 + 2 * 25 = 150
    expect(typicalSpend([100, 100, 100, 151, 150]).outlierMonths).toEqual([3]);
  });

  it('looks only at the last six values, indexing outliers within them', () => {
    const r = typicalSpend([999999, 100, 100, 100, 100, 100, 5000]);
    expect(r.months).toBe(6);
    expect(r.outlierMonths).toEqual([5]);
    expect(r.median).toBe(100);
  });

  it('copes with an empty list', () => {
    expect(typicalSpend([])).toEqual({ median: 0, min: 0, max: 0, months: 0, outlierMonths: [] });
  });
});
