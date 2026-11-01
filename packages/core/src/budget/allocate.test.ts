import { describe, expect, it } from 'vitest';
import { splitByWeights } from './allocate';

describe('splitByWeights', () => {
  it('splits pro rata and the parts sum exactly to the total (largest remainder)', () => {
    const parts = splitByWeights(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(splitByWeights(1000, [3, 1])).toEqual([750, 250]);
    expect(splitByWeights(10, [5_000, 3_000, 2_000])).toEqual([5, 3, 2]);
  });

  it('splits equally when every weight is zero', () => {
    expect(splitByWeights(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it('handles negative totals symmetrically and a single part', () => {
    expect(splitByWeights(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(splitByWeights(-7, [7])).toEqual([-7]);
    expect(splitByWeights(0, [1, 2])).toEqual([0, 0]);
    expect(splitByWeights(5, [])).toEqual([]);
  });

  it('is exact for large amounts', () => {
    const parts = splitByWeights(9_000_000_000_001, [1, 2, 4]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9_000_000_000_001);
  });
});
