import { describe, expect, it } from 'vitest';
import { crossedThresholds } from '../src/budget-alert-thresholds.js';

describe('crossedThresholds', () => {
  const ths = [80, 100];

  it('does not raise the 100% alert for a line exactly met', () => {
    expect(crossedThresholds(ths, 10_000, 10_000)).toEqual([80]);
  });

  it('raises the 100% alert once actual exceeds planned', () => {
    expect(crossedThresholds(ths, 10_001, 10_000)).toEqual([80, 100]);
  });

  it('keeps warning thresholds below 100 inclusive', () => {
    expect(crossedThresholds(ths, 8_000, 10_000)).toEqual([80]);
    expect(crossedThresholds(ths, 7_999, 10_000)).toEqual([]);
  });

  it('applies the strict rule to every threshold from 100 up', () => {
    expect(crossedThresholds([100, 150], 15_000, 10_000)).toEqual([100]);
    expect(crossedThresholds([100, 150], 15_001, 10_000)).toEqual([100, 150]);
  });
});
