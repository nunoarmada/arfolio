/**
 * Geometry and URL helpers of Análises: the period in the URL, the links into the transactions
 * list, zero-based scales, columns from a zero line and the two-panel trends layout. Pure
 * functions on plain numbers, so the components only draw what these return. The month scale,
 * ticks and paths come from `net-worth-chart.ts`, which is reused as is.
 */
import { monthEnd } from './dates';
import { shiftMonth, yScale, type XY, type YScale } from './net-worth-chart';
import { emptyFilters, filtersToParams } from './transaction-filters';

// ---------------------------------------------------------------------------------------------
// The period (URL is the state)

export type RangeKey = 1 | 3 | 12;
export const RANGE_KEYS: readonly RangeKey[] = [1, 3, 12];

/** The service limit is 120 months; the oldest selectable end month is 119 months back. */
export const MAX_END_BACK = 119;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const END = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface InsightsParams {
  range: RangeKey;
  /** The last month of the period, as the first day of that month. */
  end: string;
  /** Cash flow only; null for every account. */
  account: string | null;
}

/** Reads `range`, `end` and `account`; anything malformed falls back to its default, silently. */
export function parseInsightsParams(
  raw: { range?: string | undefined; end?: string | undefined; account?: string | undefined },
  currentMonth: string,
): InsightsParams {
  const range = (RANGE_KEYS.find((r) => String(r) === raw.range) ?? 1) as RangeKey;
  const match = raw.end ? END.exec(raw.end) : null;
  const oldest = shiftMonth(currentMonth, -MAX_END_BACK);
  let end = match ? `${match[1]}-${match[2]}-01` : currentMonth;
  if (end > currentMonth) end = currentMonth;
  if (end < oldest) end = oldest;
  return { range, end, account: raw.account && UUID.test(raw.account) ? raw.account : null };
}

/** The whole calendar months ending at `end`: first and last day, and each month's first day. */
export function insightsRange(
  range: RangeKey,
  end: string,
): { from: string; to: string; months: string[] } {
  const months = Array.from({ length: range }, (_, i) => shiftMonth(end, i - (range - 1)));
  return { from: months[0]!, to: monthEnd(end), months };
}

/** The page's own URL for a period; defaults are left out so the plain page has a clean URL. */
export function insightsHref(p: InsightsParams, currentMonth: string): string {
  const params = new URLSearchParams();
  if (p.range !== 1) params.set('range', String(p.range));
  if (p.end !== currentMonth) params.set('end', p.end.slice(0, 7));
  if (p.account) params.set('account', p.account);
  const query = params.toString();
  return query ? `/insights?${query}` : '/insights';
}

/**
 * The transactions list behind a figure: the period, booked rows only and no transfers (the
 * basis of every number on the page), so the list adds up to what the chart shows. Built with
 * the list's own filter writer, so the parameter names never drift.
 */
export function txHref(q: {
  from: string;
  to: string;
  categoryIds?: string[];
  accountId?: string;
  uncategorised?: boolean;
  direction?: 'in' | 'out';
}): string {
  const params = filtersToParams({
    ...emptyFilters(),
    period: 'custom',
    from: q.from,
    to: q.to,
    accountIds: q.accountId ? [q.accountId] : [],
    categoryIds: q.categoryIds ?? [],
    ...(q.direction ? { direction: q.direction } : {}),
    ...(q.uncategorised ? { uncategorised: true as const } : {}),
    booked: true,
    excludeTransfers: true,
  });
  return `/transactions?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Data

export interface TrendRow {
  month: string;
  income: number;
  expense: number;
  /** Net flow into saving accounts; negative when more left them than went in. */
  saving: number;
  net: number;
}

/** Drops the leading months where income, expense and saving are all 0 (before the data starts). */
export function trimLeadingEmpty<T extends Pick<TrendRow, 'income' | 'expense' | 'saving'>>(
  rows: readonly T[],
): T[] {
  const first = rows.findIndex((r) => r.income !== 0 || r.expense !== 0 || r.saving !== 0);
  return first < 0 ? [] : rows.slice(first);
}

// ---------------------------------------------------------------------------------------------
// Scales and marks

/**
 * A value domain that always includes zero. With every value at or above zero it starts at 0
 * (no negative ticks) and pads the top; otherwise it pads both sides. Ticks are 1-2-5 steps.
 */
export function zeroBasedScale(values: readonly number[], pad = 0.08): YScale {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const raw =
    lo >= 0
      ? { ...yScale([0, hi === 0 ? 10_000 : hi * (1 + pad)], 0), spansZero: false }
      : yScale([lo, hi], pad);
  return snapToTicks(raw);
}

/** The domain widened to whole tick steps, so the top (and bottom) edge is a labelled gridline. */
function snapToTicks(scale: YScale): YScale {
  const [first, second] = scale.ticks;
  if (first === undefined || second === undefined) return scale;
  const step = second - first;
  const min = scale.min >= 0 ? 0 : Math.floor(scale.min / step) * step;
  const max = Math.ceil(scale.max / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max; t += step) ticks.push(t);
  return { ...scale, min, max, ticks };
}

/** How much of the track a bar fills: its amount against the largest, never past the track. */
export function barShare(amount: number, max: number): number {
  if (max <= 0 || amount <= 0) return 0;
  return Math.min(1, amount / max);
}

/** Width of one 12px Geist glyph with room to spare (digits and the euro sign measure about 7.3px). */
const CHAR_WIDTH = 8;
/** The 8px between the label and the plot, plus slack so a wide letter ("K", "M") never clips. */
const GUTTER_SLACK = 12;

/** The left gutter that fits the longest y label. */
export function gutterWidth(labels: readonly string[]): number {
  return Math.max(0, ...labels.map((l) => l.length)) * CHAR_WIDTH + GUTTER_SLACK;
}

/** A plot area: where the drawing of one panel sits, in SVG pixels. */
export interface Box {
  left: number;
  width: number;
  top: number;
  height: number;
}

/** Value to y for a scale inside a box (the maximum at the top edge). */
export function yMapper(scale: YScale, box: Box): (value: number) => number {
  return (v) => box.top + (1 - (v - scale.min) / (scale.max - scale.min)) * box.height;
}

/** The x of the centre of month `index` of `count`, on slots of equal width. */
export function slotX(index: number, count: number, box: Box): number {
  return box.left + ((index + 0.5) * box.width) / count;
}

/** A column's width: 60% of its slot, at most `max`, never thinner than 2px. */
export function columnWidth(count: number, box: Box, max = 24, ratio = 0.6): number {
  return Math.max(2, Math.min(max, (box.width / Math.max(count, 1)) * ratio));
}

export interface ColumnRect {
  x: number;
  y: number;
  width: number;
  height: number;
  negative: boolean;
}

/**
 * One column from the zero line: up for a positive value, down for a negative one. A real value
 * is at least 1px tall so it never vanishes; zero has no height.
 */
export function columnRect(
  value: number,
  centerX: number,
  width: number,
  yOf: (value: number) => number,
  zeroY: number,
): ColumnRect {
  const x = centerX - width / 2;
  if (value === 0) return { x, y: zeroY, width, height: 0, negative: false };
  const edge = yOf(value);
  const height = Math.max(1, Math.abs(edge - zeroY));
  return value > 0
    ? { x, y: zeroY - height, width, height, negative: false }
    : { x, y: zeroY, width, height, negative: true };
}

/** Columns for `values` from one zero line in `box`, with the scale and mapper they use. */
export function columnsInBox(
  values: readonly number[],
  box: Box,
  maxWidth = 24,
): { scale: YScale; yOf: (value: number) => number; zeroY: number; columns: ColumnRect[] } {
  const scale = zeroBasedScale(values);
  const yOf = yMapper(scale, box);
  const zeroY = yOf(0);
  const width = columnWidth(values.length, box, maxWidth);
  return {
    scale,
    yOf,
    zeroY,
    columns: values.map((v, i) => columnRect(v, slotX(i, values.length, box), width, yOf, zeroY)),
  };
}

/** The x range behind months `first..last` (inclusive indexes), whole slots wide. */
export function rangeBand(
  first: number,
  last: number,
  count: number,
  box: Box,
): { x: number; width: number } {
  const slot = box.width / count;
  return { x: box.left + first * slot, width: (last - first + 1) * slot };
}

/**
 * Vertical positions for two labels at the end of two lines: where they are far enough apart they
 * stay, otherwise they move apart evenly around their middle, keeping their order.
 */
export function endLabelYs(
  a: number,
  b: number,
  minGap = 14,
  bounds?: readonly [number, number],
): [number, number] {
  let ys: [number, number] = [a, b];
  if (Math.abs(a - b) < minGap) {
    const mid = (a + b) / 2;
    const half = minGap / 2;
    // Equal positions keep their order (first above second).
    ys = a <= b ? [mid - half, mid + half] : [mid + half, mid - half];
  }
  if (!bounds) return ys;
  // Keep both inside the bounds by moving the pair as one, so the gap survives.
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const shift = hi > bounds[1] ? bounds[1] - hi : lo < bounds[0] ? bounds[0] - lo : 0;
  return [ys[0] + shift, ys[1] + shift];
}

// ---------------------------------------------------------------------------------------------
// Trends: two panels on one month axis

export interface TrendsLayoutOptions {
  width: number;
  /** Width of the y label column, left of both panels. */
  gutter: number;
  padRight: number;
  /** Room above the top panel (its title). */
  padTop: number;
  topHeight: number;
  /** Space between the panels, including the bottom panel's title. */
  gap: number;
  bottomHeight: number;
  /** Room under the bottom panel for the month labels. */
  padBottom: number;
}

export interface TrendsLayout {
  height: number;
  /** The x of each month, shared by both panels. */
  xs: number[];
  top: {
    box: Box;
    scale: YScale;
    yOf: (value: number) => number;
    income: Array<XY & { slot: number }>;
    expense: Array<XY & { slot: number }>;
  };
  bottom: {
    box: Box;
    scale: YScale;
    yOf: (value: number) => number;
    zeroY: number;
    columns: ColumnRect[];
  };
}

/**
 * Where everything of the trends chart goes: income and expense lines in a zero-based top panel,
 * saving columns from a zero line in the bottom panel (negative saving hangs below it), both on
 * the same month slots.
 */
export function trendsLayout(rows: readonly TrendRow[], o: TrendsLayoutOptions): TrendsLayout {
  const count = rows.length;
  const plotWidth = Math.max(o.width - o.gutter - o.padRight, 1);
  const topBox: Box = { left: o.gutter, width: plotWidth, top: o.padTop, height: o.topHeight };
  const bottomBox: Box = {
    left: o.gutter,
    width: plotWidth,
    top: o.padTop + o.topHeight + o.gap,
    height: o.bottomHeight,
  };
  const topScale = zeroBasedScale(rows.flatMap((r) => [r.income, r.expense]));
  const topY = yMapper(topScale, topBox);
  const xs = rows.map((_, i) => slotX(i, count, topBox));
  const bottom = columnsInBox(
    rows.map((r) => r.saving),
    bottomBox,
  );
  return {
    height: bottomBox.top + bottomBox.height + o.padBottom,
    xs,
    top: {
      box: topBox,
      scale: topScale,
      yOf: topY,
      income: rows.map((r, i) => ({ slot: i, x: xs[i]!, y: topY(r.income) })),
      expense: rows.map((r, i) => ({ slot: i, x: xs[i]!, y: topY(r.expense) })),
    },
    bottom: { box: bottomBox, ...bottom },
  };
}
