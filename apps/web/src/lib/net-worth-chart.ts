/**
 * Geometry of the net worth line chart: a continuous month scale, gaps that break the line, the
 * dashed live month, nice y ticks and the keyboard steps of the slider. Pure functions on plain
 * numbers and `yyyy-mm-01` strings, so the component only draws what these return.
 */

export interface ChartRow {
  /** First day of the month (`yyyy-mm-01`). */
  month: string;
  assets: number;
  liabilities: number;
  net: number;
  /** Difference from the previous row's net; null for the first row. */
  change: number | null;
}

/** A row placed on the month scale. */
export interface ScalePoint extends ChartRow {
  /** 0-based position of the month on the scale (months since the scale start). */
  slot: number;
}

const monthNumber = (iso: string): number =>
  Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

/** Whole months from `from` to `to` (negative when `to` is earlier). */
export function monthsBetween(from: string, to: string): number {
  return monthNumber(to) - monthNumber(from);
}

/** `month` moved by `delta` months, as the first day of that month. */
export function shiftMonth(month: string, delta: number): string {
  const total = monthNumber(month) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * The months the chart spans: from the first month that has a record (never earlier than
 * `rangeStart`) to the current month. Months before the first record are not gaps, they are
 * simply not drawn.
 */
export function monthScale(
  rows: readonly ChartRow[],
  rangeStart: string,
  currentMonth: string,
): { start: string; count: number } {
  const first = rows[0]?.month;
  const start = first && first > rangeStart ? first : rangeStart;
  return { start, count: Math.max(1, monthsBetween(start, currentMonth) + 1) };
}

/** The rows that fall on the scale, each with its slot; rows outside it are dropped. */
export function placeRows(
  rows: readonly ChartRow[],
  scale: { start: string; count: number },
): ScalePoint[] {
  return rows
    .map((r) => ({ ...r, slot: monthsBetween(scale.start, r.month) }))
    .filter((p) => p.slot >= 0 && p.slot < scale.count);
}

/** Months of the scale with no row after the first one (a gap, not a zero), oldest first. */
export function missingMonths(
  points: readonly ScalePoint[],
  scale: { start: string; count: number },
): string[] {
  const have = new Set(points.map((p) => p.slot));
  const firstSlot = points[0]?.slot;
  if (firstSlot === undefined) return [];
  const out: string[] = [];
  // The last slot is the current month, computed live: never a gap.
  for (let slot = firstSlot + 1; slot < scale.count - 1; slot++) {
    if (!have.has(slot)) out.push(shiftMonth(scale.start, slot));
  }
  return out;
}

export interface XY {
  x: number;
  y: number;
}

export interface ChartPaths {
  /** Runs of two or more consecutive months, drawn as solid polylines. */
  solid: XY[][];
  /** The live month's segment from the previous month, drawn dashed. */
  dashed: [XY, XY] | null;
  /** A month with no neighbour on either side. */
  dots: XY[];
}

/**
 * Splits positioned points into drawable parts: consecutive months join into a line, a missing
 * month breaks it, a lone month becomes a dot and the segment into the live (last) month is
 * dashed. Nothing is interpolated across a gap.
 */
export function buildPaths(
  points: ReadonlyArray<{ slot: number } & XY>,
  liveSlot: number,
): ChartPaths {
  const runs: Array<Array<{ slot: number } & XY>> = [];
  for (const p of points) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.slot === p.slot - 1) run.push(p);
    else runs.push([p]);
  }
  const solid: XY[][] = [];
  const dots: XY[] = [];
  let dashed: [XY, XY] | null = null;
  for (const run of runs) {
    const endsLive = run.at(-1)!.slot === liveSlot;
    const body = endsLive ? run.slice(0, -1) : run;
    if (endsLive && run.length >= 2) {
      const a = run.at(-2)!;
      const b = run.at(-1)!;
      dashed = [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ];
    }
    if (body.length >= 2) solid.push(body.map(({ x, y }) => ({ x, y })));
    // A single month is a dot only when nothing joins it (the live month has its own marker).
    else if (body.length === 1 && !endsLive) dots.push({ x: body[0]!.x, y: body[0]!.y });
  }
  return { solid, dashed, dots };
}

/** A 1-2-5 step at or above `raw`. */
function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const fraction = raw / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

export interface YScale {
  min: number;
  max: number;
  ticks: number[];
  /** True when the domain spans zero (a zero line is drawn). */
  spansZero: boolean;
}

/**
 * The value domain and its ticks: [min, max] padded by 8%; a flat series is padded by 10% of its
 * value (100 in major units when it is 0). Ticks are 1-2-5 steps, about four of them, inside the
 * domain.
 */
export function yScale(values: readonly number[], pad = 0.08, flatFallbackMinor = 10_000): YScale {
  if (values.length === 0) return { min: 0, max: 1, ticks: [0], spansZero: false };
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    const delta = lo === 0 ? flatFallbackMinor : Math.abs(lo) * 0.1;
    lo -= delta;
    hi += delta;
  } else {
    const delta = (hi - lo) * pad;
    lo -= delta;
    hi += delta;
  }
  const step = Math.max(1, niceStep((hi - lo) / 4));
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(Math.round(t));
  return { min: lo, max: hi, ticks, spansZero: lo < 0 && hi > 0 };
}

/**
 * The slots that carry an x label: at most `max`, evenly spaced and always including the first
 * and the last month.
 */
export function xLabelSlots(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  if (max < 2) return [0, count - 1];
  const slots = new Set<number>();
  for (let i = 0; i < max; i++) slots.add(Math.round((i * (count - 1)) / (max - 1)));
  return [...slots].sort((a, b) => a - b);
}

/** The index (in `slots`, ascending) of the slot closest to `slot`. */
export function nearestIndex(slots: readonly number[], slot: number): number {
  let best = 0;
  for (let i = 1; i < slots.length; i++) {
    if (Math.abs(slots[i]! - slot) < Math.abs(slots[best]! - slot)) best = i;
  }
  return best;
}

/** Keyboard on the slider: arrows step between existing months, Home/End jump, Page keys move 12. */
export function stepIndex(current: number, key: string, count: number): number | null {
  const last = count - 1;
  const clamp = (n: number) => Math.min(Math.max(n, 0), last);
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(current - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(current + 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'PageDown':
      return clamp(current - 12);
    case 'PageUp':
      return clamp(current + 12);
    default:
      return null;
  }
}
