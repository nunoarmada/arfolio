import { buildPaths, placeRows, yScale, type ChartRow, type XY } from './net-worth-chart';

export interface SparklineGeometry {
  /** Runs of two or more consecutive months, in percent of the frame (x and y, 0..100). */
  solid: XY[][];
  /** The segment into the live month. */
  dashed: [XY, XY] | null;
  /** A month with no neighbour on either side. */
  dots: XY[];
  /** The live month's point (the hollow end dot), when the series reaches it. */
  end: XY | null;
  first: { month: string; net: number };
  last: { month: string; net: number };
}

/** Round to two decimals so the markup stays short and stable. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The home sparkline in a 0..100 by 0..100 frame, so one SVG with a stretched viewBox and a
 * percent-positioned end dot fit any width. Net worth over `scale` (its last slot is the live
 * month): a missing month breaks the line, nothing is interpolated, the axis does not start at
 * zero (the shape of the change is the point) and a flat series sits in the middle. Null with
 * fewer than two points: one month has no shape.
 */
export function sparkline(
  rows: readonly ChartRow[],
  scale: { start: string; count: number },
): SparklineGeometry | null {
  const points = placeRows(rows, scale);
  if (points.length < 2) return null;
  const y = yScale(
    points.map((p) => p.net),
    0.12,
  );
  const span = y.max - y.min;
  const placed = points.map((p) => ({
    slot: p.slot,
    x: r2((p.slot / (scale.count - 1)) * 100),
    y: r2((1 - (p.net - y.min) / span) * 100),
  }));
  const liveSlot = scale.count - 1;
  const paths = buildPaths(placed, liveSlot);
  const tail = placed.at(-1)!;
  const head = points[0]!;
  const last = points.at(-1)!;
  return {
    ...paths,
    end: tail.slot === liveSlot ? { x: tail.x, y: tail.y } : null,
    first: { month: head.month, net: head.net },
    last: { month: last.month, net: last.net },
  };
}
