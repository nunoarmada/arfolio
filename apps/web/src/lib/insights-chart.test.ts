import { describe, expect, it } from 'vitest';
import { buildPaths } from './net-worth-chart';
import {
  barShare,
  columnRect,
  columnsInBox,
  columnWidth,
  endLabelYs,
  gutterWidth,
  insightsHref,
  insightsRange,
  parseInsightsParams,
  rangeBand,
  trendsLayout,
  trimLeadingEmpty,
  txHref,
  yMapper,
  zeroBasedScale,
  type TrendRow,
} from './insights-chart';
import { parseFilters } from './transaction-filters';

const ID = '3f2b8c1e-5d4a-4e8b-9a77-0c1d2e3f4a5b';
const ID2 = '9a1d6f3e-0b52-4c37-8e4a-7d21c5b09f10';

const row = (month: string, income: number, expense: number, saving = 0): TrendRow => ({
  month,
  income,
  expense,
  saving,
  net: income - expense,
});

describe('parseInsightsParams', () => {
  const current = '2026-10-01';

  it('defaults to the current month and a one-month range', () => {
    expect(parseInsightsParams({}, current)).toEqual({ range: 1, end: current, account: null });
  });

  it('reads range, end and account', () => {
    expect(parseInsightsParams({ range: '3', end: '2026-08', account: ID }, current)).toEqual({
      range: 3,
      end: '2026-08-01',
      account: ID,
    });
    expect(parseInsightsParams({ range: '12' }, current).range).toBe(12);
  });

  it('falls back silently on malformed values', () => {
    expect(
      parseInsightsParams({ range: '7', end: '2026-13', account: 'not-a-uuid' }, current),
    ).toEqual({ range: 1, end: current, account: null });
    expect(parseInsightsParams({ end: 'garbage' }, current).end).toBe(current);
    expect(parseInsightsParams({ range: '' }, current).range).toBe(1);
  });

  it('clamps end to the current month and to 119 months back', () => {
    expect(parseInsightsParams({ end: '2027-03' }, current).end).toBe(current);
    expect(parseInsightsParams({ end: '2026-10' }, current).end).toBe(current);
    expect(parseInsightsParams({ end: '2016-11' }, current).end).toBe('2016-11-01');
    expect(parseInsightsParams({ end: '2016-10' }, current).end).toBe('2016-11-01');
    expect(parseInsightsParams({ end: '1999-01' }, current).end).toBe('2016-11-01');
  });
});

describe('insightsRange', () => {
  it('is the whole calendar months ending at `end`', () => {
    expect(insightsRange(1, '2026-10-01')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      months: ['2026-10-01'],
    });
    expect(insightsRange(3, '2026-10-01')).toEqual({
      from: '2026-08-01',
      to: '2026-10-31',
      months: ['2026-08-01', '2026-09-01', '2026-10-01'],
    });
  });

  it('crosses a year boundary and a leap February', () => {
    const r = insightsRange(12, '2028-02-01');
    expect(r.from).toBe('2027-03-01');
    expect(r.to).toBe('2028-02-29');
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toBe('2027-03-01');
    expect(r.months.at(-1)).toBe('2028-02-01');
  });
});

describe('insightsHref', () => {
  const current = '2026-10-01';
  it('omits defaults so the plain page keeps a clean URL', () => {
    expect(insightsHref({ range: 1, end: current, account: null }, current)).toBe('/insights');
  });
  it('keeps every non-default parameter', () => {
    expect(insightsHref({ range: 3, end: '2026-08-01', account: ID }, current)).toBe(
      `/insights?range=3&end=2026-08&account=${ID}`,
    );
    expect(insightsHref({ range: 1, end: '2026-08-01', account: null }, current)).toBe(
      '/insights?end=2026-08',
    );
  });
});

describe('txHref', () => {
  it('builds a custom-period, booked-only, transfer-free list through the filter parser', () => {
    const href = txHref({ from: '2026-10-01', to: '2026-10-31', categoryIds: [ID, ID2] });
    expect(href.startsWith('/transactions?')).toBe(true);
    const f = parseFilters(new URLSearchParams(href.split('?')[1]));
    expect(f).toMatchObject({
      period: 'custom',
      from: '2026-10-01',
      to: '2026-10-31',
      categoryIds: [ID, ID2],
      booked: true,
      excludeTransfers: true,
    });
    expect(f.direction).toBeUndefined();
    expect(f.uncategorised).toBeUndefined();
  });

  it('links an account, and uncategorised outflows', () => {
    const acc = parseFilters(
      new URLSearchParams(
        txHref({ from: '2026-10-01', to: '2026-10-31', accountId: ID }).split('?')[1],
      ),
    );
    expect(acc.accountIds).toEqual([ID]);
    const un = parseFilters(
      new URLSearchParams(
        txHref({
          from: '2026-10-01',
          to: '2026-10-31',
          uncategorised: true,
          direction: 'out',
        }).split('?')[1],
      ),
    );
    expect(un).toMatchObject({ uncategorised: true, direction: 'out', booked: true });
  });

  it('is the plain period when nothing else is asked', () => {
    expect(txHref({ from: '2026-10-01', to: '2026-10-31' })).toBe(
      '/transactions?period=custom&from=2026-10-01&to=2026-10-31&status=booked&transfers=exclude',
    );
  });
});

describe('zeroBasedScale', () => {
  it('starts at zero and drops negative ticks when every value is non-negative', () => {
    const s = zeroBasedScale([120_000, 345_000, 280_000]);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThan(345_000);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks.every((t) => t >= 0 && t <= s.max)).toBe(true);
    expect(s.spansZero).toBe(false);
    // 1-2-5 steps: the gaps between ticks are all equal.
    const gaps = new Set(s.ticks.slice(1).map((t, i) => t - s.ticks[i]!));
    expect(gaps.size).toBe(1);
    expect([1, 2, 5]).toContain(Number(String([...gaps][0]).replace(/0+$/, '')));
  });

  it('pads both sides and keeps zero inside the domain when a value is negative', () => {
    const s = zeroBasedScale([-30_000, 20_000, 10_000]);
    expect(s.min).toBeLessThan(-30_000);
    expect(s.max).toBeGreaterThan(20_000);
    expect(s.spansZero).toBe(true);
    expect(s.ticks).toContain(0);
    expect(s.ticks.some((t) => t < 0)).toBe(true);
  });

  it('keeps zero in the domain when everything is negative', () => {
    const s = zeroBasedScale([-40_000, -10_000]);
    expect(s.max).toBeGreaterThanOrEqual(0);
    expect(s.min).toBeLessThan(-40_000);
    expect(s.ticks).toContain(0);
  });

  it('gives a flat zero series a usable domain', () => {
    const s = zeroBasedScale([0, 0, 0]);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThan(0);
    expect(s.ticks[0]).toBe(0);
    expect(zeroBasedScale([]).min).toBe(0);
  });
});

describe('trimLeadingEmpty', () => {
  it('drops the leading months with no income, expense or saving', () => {
    const rows = [
      row('2026-01', 0, 0),
      row('2026-02', 0, 0),
      row('2026-03', 100, 0),
      row('2026-04', 0, 0),
      row('2026-05', 0, 50),
    ];
    expect(trimLeadingEmpty(rows).map((r) => r.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  it('counts a month with only saving as data, keeps interior zeros, and may empty out', () => {
    expect(trimLeadingEmpty([row('2026-01', 0, 0, -300), row('2026-02', 0, 0)])).toHaveLength(2);
    expect(trimLeadingEmpty([row('2026-01', 0, 0), row('2026-02', 0, 0)])).toEqual([]);
    expect(trimLeadingEmpty([])).toEqual([]);
  });
});

describe('bars', () => {
  it('scales a bar against the largest value, never past the track', () => {
    expect(barShare(500, 1000)).toBe(0.5);
    expect(barShare(1000, 1000)).toBe(1);
    expect(barShare(2000, 1000)).toBe(1);
    expect(barShare(0, 1000)).toBe(0);
    expect(barShare(10, 0)).toBe(0);
    expect(barShare(-10, 100)).toBe(0);
  });

  it('sizes a column from its slot, capped at 24px', () => {
    const box = { left: 0, width: 240, top: 0, height: 100 };
    expect(columnWidth(12, box)).toBeCloseTo(12);
    expect(columnWidth(3, box)).toBe(24);
    expect(columnWidth(500, box)).toBeGreaterThanOrEqual(2);
  });

  it('draws a positive column up from the zero line and a negative one down from it', () => {
    const box = { left: 0, width: 100, top: 10, height: 100 };
    const scale = { min: -100, max: 100, ticks: [-100, 0, 100], spansZero: true };
    const yOf = yMapper(scale, box);
    expect(yOf(100)).toBe(10);
    expect(yOf(-100)).toBe(110);
    const zeroY = yOf(0);
    expect(zeroY).toBe(60);
    const up = columnRect(50, 20, 10, yOf, zeroY);
    expect(up).toMatchObject({ x: 15, y: 35, width: 10, height: 25, negative: false });
    const down = columnRect(-50, 20, 10, yOf, zeroY);
    expect(down).toMatchObject({ x: 15, y: 60, width: 10, height: 25, negative: true });
    // A real but tiny value is still visible; zero is not drawn.
    expect(columnRect(1, 20, 10, yOf, zeroY).height).toBeGreaterThanOrEqual(1);
    expect(columnRect(0, 20, 10, yOf, zeroY).height).toBe(0);
  });
});

describe('cash flow net columns', () => {
  it('puts a surplus above and a deficit below one shared zero line, inside the box', () => {
    const box = { left: 40, width: 240, top: 8, height: 120 };
    const { columns, zeroY, scale } = columnsInBox([120_000, -45_000, 0], box);
    expect(scale.spansZero).toBe(true);
    expect(columns).toHaveLength(3);
    const [surplus, deficit, flat] = columns as [
      (typeof columns)[number],
      (typeof columns)[number],
      (typeof columns)[number],
    ];
    expect(surplus.y + surplus.height).toBeCloseTo(zeroY);
    expect(surplus.negative).toBe(false);
    expect(deficit.y).toBeCloseTo(zeroY);
    expect(deficit.negative).toBe(true);
    expect(flat.height).toBe(0);
    for (const c of columns) {
      expect(c.y).toBeGreaterThanOrEqual(box.top - 0.5);
      expect(c.y + c.height).toBeLessThanOrEqual(box.top + box.height + 0.5);
    }
    // Columns sit in slot order, left to right, inside the plot.
    expect(surplus.x).toBeLessThan(deficit.x);
    expect(deficit.x).toBeLessThan(flat.x);
    expect(surplus.x).toBeGreaterThanOrEqual(box.left);
    expect(flat.x + flat.width).toBeLessThanOrEqual(box.left + box.width);
  });

  it('sits all-positive columns on the bottom edge (zero is the axis floor)', () => {
    const box = { left: 0, width: 100, top: 0, height: 100 };
    const { columns, zeroY, scale } = columnsInBox([10, 20], box);
    expect(scale.min).toBe(0);
    expect(zeroY).toBe(100);
    for (const c of columns) expect(c.y + c.height).toBeCloseTo(100);
  });
});

describe('trends layout (two panels, shared month axis)', () => {
  const opts = {
    width: 360,
    gutter: 48,
    padRight: 8,
    padTop: 20,
    topHeight: 180,
    gap: 36,
    bottomHeight: 110,
    padBottom: 24,
  };
  const rows = [
    row('2026-05', 300_000, 250_000, 40_000),
    row('2026-06', 310_000, 340_000, -30_000),
    row('2026-07', 0, 0, 0),
    row('2026-08', 320_000, 200_000, 60_000),
  ];

  it('stacks the panels: top above gap above bottom, total height adds up', () => {
    const l = trendsLayout(rows, opts);
    expect(l.top.box.top).toBe(20);
    expect(l.top.box.height).toBe(180);
    expect(l.bottom.box.top).toBe(20 + 180 + 36);
    expect(l.bottom.box.height).toBe(110);
    expect(l.height).toBe(20 + 180 + 36 + 110 + 24);
    expect(l.top.box.left).toBe(opts.gutter);
    expect(l.top.box.width).toBe(360 - 48 - 8);
    expect(l.bottom.box.left).toBe(l.top.box.left);
  });

  it('shares one x position per month across both panels', () => {
    const l = trendsLayout(rows, opts);
    expect(l.xs).toHaveLength(4);
    l.xs.forEach((x, i) => {
      expect(x).toBeCloseTo(opts.gutter + ((i + 0.5) * (360 - 48 - 8)) / 4);
      expect(l.top.income[i]!.x).toBe(x);
      expect(l.top.expense[i]!.x).toBe(x);
      expect(l.bottom.columns[i]!.x + l.bottom.columns[i]!.width / 2).toBeCloseTo(x);
    });
  });

  it('is zero-based on top: the larger series is higher, zero is the floor', () => {
    const l = trendsLayout(rows, opts);
    expect(l.top.scale.min).toBe(0);
    // June: expense 340k above income 310k, so a smaller y.
    expect(l.top.expense[1]!.y).toBeLessThan(l.top.income[1]!.y);
    // The empty month sits on the floor, not in a gap.
    expect(l.top.income[2]!.y).toBeCloseTo(l.top.box.top + l.top.box.height);
    expect(l.top.expense[2]!.y).toBeCloseTo(l.top.box.top + l.top.box.height);
  });

  it('draws a negative saving below the zero baseline, a positive one above, inside the panel', () => {
    const l = trendsLayout(rows, opts);
    const { box, zeroY, columns, scale } = l.bottom;
    expect(scale.spansZero).toBe(true);
    expect(zeroY).toBeGreaterThan(box.top);
    expect(zeroY).toBeLessThan(box.top + box.height);
    const [may, june, july, august] = columns as [
      (typeof columns)[number],
      (typeof columns)[number],
      (typeof columns)[number],
      (typeof columns)[number],
    ];
    expect(may.y + may.height).toBeCloseTo(zeroY);
    expect(june.negative).toBe(true);
    expect(june.y).toBeCloseTo(zeroY);
    expect(june.y + june.height).toBeLessThanOrEqual(box.top + box.height + 0.5);
    expect(july.height).toBe(0);
    expect(august.y + august.height).toBeCloseTo(zeroY);
    // The bottom panel has its own scale: saving in hundreds is not flattened by income.
    expect(Math.max(...columns.map((c) => c.height))).toBeGreaterThan(30);
  });

  it('keeps the zero line at the floor when saving is never negative', () => {
    const l = trendsLayout([row('a', 10, 5, 5), row('b', 10, 5, 3)], opts);
    expect(l.bottom.scale.min).toBe(0);
    expect(l.bottom.zeroY).toBeCloseTo(l.bottom.box.top + l.bottom.box.height);
  });

  it('joins consecutive months into a solid line with the live month dashed', () => {
    const l = trendsLayout(rows, opts);
    const paths = buildPaths(l.top.income, rows.length - 1);
    expect(paths.solid).toHaveLength(1);
    expect(paths.solid[0]).toHaveLength(3);
    expect(paths.dashed).not.toBeNull();
  });
});

describe('range band', () => {
  it('spans the selected months, whole slots wide', () => {
    const box = { left: 40, width: 120, top: 0, height: 50 };
    // 12 slots of 10px; the last three selected.
    expect(rangeBand(9, 11, 12, box)).toEqual({ x: 40 + 90, width: 30 });
    expect(rangeBand(11, 11, 12, box)).toEqual({ x: 40 + 110, width: 10 });
    expect(rangeBand(0, 11, 12, box)).toEqual({ x: 40, width: 120 });
  });
});

describe('end labels', () => {
  it('leaves labels that are far enough apart alone', () => {
    expect(endLabelYs(40, 100)).toEqual([40, 100]);
  });
  it('pushes colliding labels apart, evenly, and keeps their order', () => {
    const [a, b] = endLabelYs(50, 54);
    expect(b - a).toBe(14);
    expect((a + b) / 2).toBe(52);
    const [c, d] = endLabelYs(54, 50);
    expect(c - d).toBe(14);
    const [e, f] = endLabelYs(60, 60);
    expect(f - e).toBe(14);
  });
  it('moves a pair that would leave the bounds as one, keeping the gap', () => {
    const [a, b] = endLabelYs(200, 200, 16, [10, 194]);
    expect(b).toBe(194);
    expect(b - a).toBe(16);
    const [c, d] = endLabelYs(12, 12, 16, [10, 194]);
    expect(c).toBe(10);
    expect(d - c).toBe(16);
    expect(endLabelYs(40, 100, 16, [10, 194])).toEqual([40, 100]);
  });
});

describe('gutterWidth', () => {
  it('sizes the label column from the longest label', () => {
    expect(gutterWidth(['0', '10 mil €', '5 mil €'])).toBe('10 mil €'.length * 8 + 12);
    expect(gutterWidth([])).toBe(12);
    // "€100K" at 12px Geist is about 37px and sits 8px left of the plot: it must fit.
    expect(gutterWidth(['€100K'])).toBeGreaterThanOrEqual(37 + 8 + 4);
  });
});

describe('zeroBasedScale snapping', () => {
  it('ends the domain on a labelled tick, top and bottom', () => {
    for (const values of [
      [120_000, 345_000, 280_000],
      [-30_000, 20_000],
      [-40_000, -10_000],
      [7, 9],
    ]) {
      const s = zeroBasedScale(values);
      expect(s.ticks.at(-1)).toBe(s.max);
      expect(s.ticks[0]).toBe(s.min);
      expect(s.ticks).toContain(0);
    }
  });
});
