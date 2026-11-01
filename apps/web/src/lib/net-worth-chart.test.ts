import { describe, expect, it } from 'vitest';
import {
  buildPaths,
  missingMonths,
  monthScale,
  monthsBetween,
  nearestIndex,
  placeRows,
  shiftMonth,
  stepIndex,
  xLabelSlots,
  yScale,
  type ChartRow,
} from './net-worth-chart';

const row = (month: string, net: number): ChartRow => ({
  month,
  assets: net + 100,
  liabilities: 100,
  net,
  change: null,
});

describe('month arithmetic', () => {
  it('counts whole months across years', () => {
    expect(monthsBetween('2025-11-01', '2026-02-01')).toBe(3);
    expect(monthsBetween('2026-02-01', '2025-11-01')).toBe(-3);
  });
  it('shifts a month in both directions', () => {
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftMonth('2025-12-01', 2)).toBe('2026-02-01');
    expect(shiftMonth('2026-10-01', -11)).toBe('2025-11-01');
  });
});

describe('monthScale and placeRows', () => {
  it('starts at the range start when the data goes back further', () => {
    const rows = [row('2025-01-01', 1), row('2026-10-01', 2)];
    const scale = monthScale(rows, '2025-11-01', '2026-10-01');
    expect(scale).toEqual({ start: '2025-11-01', count: 12 });
    // the row before the range is dropped
    expect(placeRows(rows, scale).map((p) => p.slot)).toEqual([11]);
  });
  it('starts at the first record when it is later than the range start', () => {
    const rows = [row('2026-08-01', 1), row('2026-09-01', 2), row('2026-10-01', 3)];
    const scale = monthScale(rows, '2025-11-01', '2026-10-01');
    expect(scale).toEqual({ start: '2026-08-01', count: 3 });
  });
  it('has one slot when only the current month exists', () => {
    expect(monthScale([row('2026-10-01', 1)], '2025-11-01', '2026-10-01').count).toBe(1);
    expect(monthScale([], '2025-11-01', '2026-10-01').count).toBe(12);
  });
});

describe('missingMonths', () => {
  it('lists past months with no row after the first record, not the live month', () => {
    const rows = [row('2026-05-01', 1), row('2026-08-01', 2), row('2026-10-01', 3)];
    const scale = monthScale(rows, '2026-01-01', '2026-10-01');
    const points = placeRows(rows, scale);
    expect(missingMonths(points, scale)).toEqual(['2026-06-01', '2026-07-01', '2026-09-01']);
  });
  it('is empty without records and when nothing is missing', () => {
    expect(missingMonths([], { start: '2026-01-01', count: 3 })).toEqual([]);
    const rows = [row('2026-09-01', 1), row('2026-10-01', 2)];
    const scale = monthScale(rows, '2026-01-01', '2026-10-01');
    expect(missingMonths(placeRows(rows, scale), scale)).toEqual([]);
  });
});

describe('buildPaths', () => {
  const at = (slot: number) => ({ slot, x: slot * 10, y: 100 - slot });

  it('joins consecutive months and dashes the segment into the live month', () => {
    const paths = buildPaths([at(0), at(1), at(2), at(3)], 3);
    expect(paths.solid).toEqual([
      [
        { x: 0, y: 100 },
        { x: 10, y: 99 },
        { x: 20, y: 98 },
      ],
    ]);
    expect(paths.dashed).toEqual([
      { x: 20, y: 98 },
      { x: 30, y: 97 },
    ]);
    expect(paths.dots).toEqual([]);
  });

  it('breaks the line at a missing month and never interpolates', () => {
    const paths = buildPaths([at(0), at(1), at(3), at(4), at(5)], 5);
    expect(paths.solid).toHaveLength(2);
    expect(paths.solid[0]).toHaveLength(2);
    expect(paths.solid[1]).toHaveLength(2);
    expect(paths.dashed).toEqual([
      { x: 40, y: 96 },
      { x: 50, y: 95 },
    ]);
  });

  it('draws an isolated month as a dot', () => {
    // 0 is alone, 2-3 are a run of two, 5 is the live month with no neighbour
    const paths = buildPaths([at(0), at(2), at(3), at(5)], 5);
    expect(paths.dots).toEqual([{ x: 0, y: 100 }]);
    expect(paths.solid).toEqual([
      [
        { x: 20, y: 98 },
        { x: 30, y: 97 },
      ],
    ]);
    expect(paths.dashed).toBeNull();
  });

  it('keeps a lone live month out of the dots (it has its own hollow marker)', () => {
    const paths = buildPaths([at(0), at(1), at(4)], 4);
    expect(paths.dots).toEqual([]);
    expect(paths.dashed).toBeNull();
    expect(paths.solid).toHaveLength(1);
  });

  it('has no dashed segment when the previous month is missing or live is not last', () => {
    expect(buildPaths([at(0)], 3).dashed).toBeNull();
    expect(buildPaths([at(0), at(1)], 3).dashed).toBeNull();
  });
});

describe('yScale', () => {
  it('pads by 8% and picks 1-2-5 ticks inside the domain', () => {
    const y = yScale([100_000, 200_000]);
    expect(y.min).toBeCloseTo(92_000);
    expect(y.max).toBeCloseTo(208_000);
    expect(y.ticks).toEqual([100_000, 150_000, 200_000]);
    for (const t of y.ticks) {
      expect(t).toBeGreaterThanOrEqual(y.min);
      expect(t).toBeLessThanOrEqual(y.max);
    }
    expect(y.spansZero).toBe(false);
  });
  it('pads a flat series by 10% of its value', () => {
    const y = yScale([50_000, 50_000]);
    expect(y.min).toBeCloseTo(45_000);
    expect(y.max).toBeCloseTo(55_000);
  });
  it('pads a flat zero series by 100 in major units', () => {
    const y = yScale([0]);
    expect(y.min).toBe(-10_000);
    expect(y.max).toBe(10_000);
    expect(y.spansZero).toBe(true);
    expect(y.ticks).toContain(0);
  });
  it('flags a domain that spans zero', () => {
    expect(yScale([-5_000, 12_000]).spansZero).toBe(true);
  });
  it('gives about four ticks over awkward ranges', () => {
    const y = yScale([18_234_000, 19_876_500]);
    expect(y.ticks.length).toBeGreaterThanOrEqual(3);
    expect(y.ticks.length).toBeLessThanOrEqual(6);
    const steps = y.ticks.slice(1).map((t, i) => t - y.ticks[i]!);
    expect(new Set(steps).size).toBe(1);
  });
});

describe('xLabelSlots', () => {
  it('labels every month when they fit', () => {
    expect(xLabelSlots(4, 6)).toEqual([0, 1, 2, 3]);
  });
  it('keeps the first and last month and spreads the rest', () => {
    const slots = xLabelSlots(24, 6);
    expect(slots).toHaveLength(6);
    expect(slots[0]).toBe(0);
    expect(slots.at(-1)).toBe(23);
  });
  it('copes with degenerate input', () => {
    expect(xLabelSlots(0, 6)).toEqual([]);
    expect(xLabelSlots(1, 6)).toEqual([0]);
    expect(xLabelSlots(10, 1)).toEqual([0, 9]);
  });
});

describe('nearestIndex', () => {
  it('snaps to the closest existing month, skipping gaps', () => {
    const slots = [0, 1, 5, 6];
    expect(nearestIndex(slots, 1.2)).toBe(1);
    expect(nearestIndex(slots, 2.9)).toBe(1);
    expect(nearestIndex(slots, 3.2)).toBe(2);
    expect(nearestIndex(slots, 99)).toBe(3);
    expect(nearestIndex(slots, -4)).toBe(0);
  });
});

describe('stepIndex', () => {
  it('moves one existing month with the arrows and stays in range', () => {
    expect(stepIndex(2, 'ArrowLeft', 5)).toBe(1);
    expect(stepIndex(2, 'ArrowRight', 5)).toBe(3);
    expect(stepIndex(0, 'ArrowLeft', 5)).toBe(0);
    expect(stepIndex(4, 'ArrowRight', 5)).toBe(4);
  });
  it('jumps with Home, End and the page keys', () => {
    expect(stepIndex(7, 'Home', 30)).toBe(0);
    expect(stepIndex(7, 'End', 30)).toBe(29);
    expect(stepIndex(15, 'PageDown', 30)).toBe(3);
    expect(stepIndex(15, 'PageUp', 30)).toBe(27);
    expect(stepIndex(25, 'PageUp', 30)).toBe(29);
  });
  it('ignores other keys', () => {
    expect(stepIndex(2, 'a', 5)).toBeNull();
  });
});
