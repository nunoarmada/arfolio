import { describe, expect, it } from 'vitest';
import type { ChartRow } from './net-worth-chart';
import { sparkline } from './sparkline';

const row = (month: string, net: number): ChartRow => ({
  month,
  assets: net,
  liabilities: 0,
  net,
  change: null,
});
const scale = (start: string, count: number) => ({ start, count });

describe('sparkline', () => {
  it('draws nothing for fewer than two points', () => {
    expect(sparkline([], scale('2026-10-01', 1))).toBeNull();
    expect(sparkline([row('2026-10-01', 100)], scale('2026-10-01', 1))).toBeNull();
  });

  it('spans the full width: first month at 0, last at 100', () => {
    const g = sparkline(
      [row('2026-08-01', 100), row('2026-09-01', 200), row('2026-10-01', 300)],
      scale('2026-08-01', 3),
    )!;
    const xs = g.solid.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBe(0);
    expect(g.end?.x).toBe(100);
  });

  it('draws a rising series upwards (smaller y is higher) inside the frame', () => {
    const g = sparkline([row('2026-09-01', 100), row('2026-10-01', 300)], scale('2026-09-01', 2))!;
    const [first, second] = [g.dashed![0], g.dashed![1]];
    expect(second.y).toBeLessThan(first.y);
    for (const p of [first, second]) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(100);
    }
  });

  it('dashes the segment into the live month and ends on its dot', () => {
    const g = sparkline(
      [row('2026-08-01', 100), row('2026-09-01', 200), row('2026-10-01', 150)],
      scale('2026-08-01', 3),
    )!;
    expect(g.solid).toHaveLength(1);
    expect(g.solid[0]).toHaveLength(2);
    expect(g.dashed).not.toBeNull();
    expect(g.end).toEqual(g.dashed![1]);
  });

  it('breaks the line at a missing month instead of interpolating', () => {
    const g = sparkline(
      [
        row('2026-05-01', 100),
        row('2026-06-01', 110),
        // July and August are missing.
        row('2026-09-01', 130),
        row('2026-10-01', 140),
      ],
      scale('2026-05-01', 6),
    )!;
    // May-June is a run; July and August are not drawn; September joins the live month dashed.
    expect(g.solid).toHaveLength(1);
    expect(g.solid[0]!.map((p) => p.x)).toEqual([0, 20]);
    expect(g.dashed![0].x).toBe(80);
    expect(g.end?.x).toBe(100);
  });

  it('fits a flat series in the middle instead of dividing by zero', () => {
    const g = sparkline([row('2026-09-01', 500), row('2026-10-01', 500)], scale('2026-09-01', 2))!;
    for (const p of [...g.dashed!]) expect(Number.isFinite(p.y)).toBe(true);
    expect(g.dashed![0].y).toBeCloseTo(50, 5);
  });

  it('lets a falling series fall and a negative net stay on the scale', () => {
    const g = sparkline([row('2026-09-01', 200), row('2026-10-01', -300)], scale('2026-09-01', 2))!;
    expect(g.dashed![1].y).toBeGreaterThan(g.dashed![0].y);
  });

  it('has no end dot when the last point is not the live month', () => {
    const g = sparkline([row('2026-07-01', 100), row('2026-08-01', 120)], scale('2026-07-01', 4))!;
    expect(g.end).toBeNull();
  });

  it('describes the first and last values for the caption', () => {
    const g = sparkline(
      [row('2026-08-01', 100), row('2026-09-01', 200), row('2026-10-01', 300)],
      scale('2026-08-01', 3),
    )!;
    expect(g.first).toEqual({ month: '2026-08-01', net: 100 });
    expect(g.last).toEqual({ month: '2026-10-01', net: 300 });
  });
});
