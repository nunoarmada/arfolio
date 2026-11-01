'use client';

import { useTranslations } from 'next-intl';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  columnWidth,
  endLabelYs,
  gutterWidth,
  rangeBand,
  trendsLayout,
  zeroBasedScale,
  type ColumnRect,
  type TrendRow,
} from '@/lib/insights-chart';
import { signedMoney } from '@/lib/insights-format';
import { formatMonthShort } from '@/lib/dates';
import { buildPaths, stepIndex, xLabelSlots } from '@/lib/net-worth-chart';
import { formatMonthOnly, formatMonthTitle, formatMonthYear } from '@/lib/net-worth-format';
import { useHouseholdFormat } from '../household-format';
import { AreaGradient, CHART_GRID } from '../charts/chart-primitives';
import { useMedia, useWidth } from '../charts/use-chart-frame';
import { SectionCard } from './section-card';
import { TrendsTable } from './trends-table';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';
const PAD_TOP = 20;
const GAP = 36;
const PAD_BOTTOM = 24;

const heights = (wide: boolean) => ({ top: wide ? 220 : 180, bottom: wide ? 130 : 110 });

/** A column with its outer end rounded by 2px (up for a positive value, down for a negative). */
function columnPath(c: ColumnRect): string {
  const r = Math.min(2, c.height / 2, c.width / 2);
  const { x, y, width: w, height: h } = c;
  return c.negative
    ? `M${x},${y}h${w}v${h - r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}z`
    : `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}

function Legend({ showBand }: { showBand: boolean }) {
  const t = useTranslations('insights.trends');
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <svg aria-hidden="true" width="16" height="10" viewBox="0 0 16 10">
          <line x1="0" x2="16" y1="5" y2="5" strokeWidth="2" className="stroke-positive" />
          <circle cx="8" cy="5" r="3" className="fill-positive" />
        </svg>
        {t('income')}
      </li>
      <li className="flex items-center gap-1.5">
        <svg aria-hidden="true" width="16" height="10" viewBox="0 0 16 10">
          <line x1="0" x2="16" y1="5" y2="5" strokeWidth="2" className="stroke-chart-1" />
          <rect x="5" y="2" width="6" height="6" className="fill-chart-1" />
        </svg>
        {t('expense')}
      </li>
      <li className="flex items-center gap-1.5">
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
          <rect width="10" height="10" rx="2" className="fill-chart-2" />
        </svg>
        {t('saving')}
      </li>
      {showBand ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-3 rounded-sm border border-input bg-surface-2" />
          {t('selected')}
        </li>
      ) : null}
    </ul>
  );
}

function TrendsPlot({
  rows,
  selected,
  currentMonth,
}: {
  rows: TrendRow[];
  selected: readonly string[];
  currentMonth: string;
}) {
  const t = useTranslations('insights.trends');
  const common = useTranslations('insights');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const width = useWidth(frame);
  const wide = useMedia('(min-width: 768px)');
  const gradientId = useId();
  const count = rows.length;
  const h = heights(wide);
  const frameHeight = PAD_TOP + h.top + GAP + h.bottom + PAD_BOTTOM;

  const found = activeMonth === null ? -1 : rows.findIndex((r) => r.month === activeMonth);
  const index = found >= 0 ? found : count - 1;
  const active = rows[index]!;
  const live = rows.at(-1)!.month === currentMonth;

  const geo = useMemo(() => {
    if (width === 0) return null;
    const compact = (v: number) =>
      `${v < 0 ? MINUS : ''}${formatMoney(Math.abs(v), currency, locale, { compact: true })}`;
    const topTicks = zeroBasedScale(rows.flatMap((r) => [r.income, r.expense])).ticks;
    const bottomTicks = zeroBasedScale(rows.map((r) => r.saving)).ticks;
    const topLabels = topTicks.map((value) => ({ value, text: compact(value) }));
    // With no saving at all the scale is made up, so it gets no tick labels (the note says why).
    const bottomLabels = rows.every((r) => r.saving === 0)
      ? []
      : bottomTicks.map((value) => ({ value, text: compact(value) }));
    const gutter = gutterWidth([...topLabels, ...bottomLabels].map((l) => l.text));
    // The end labels ("Entradas", "Saídas") need room on the right; under 360px the legend stands in.
    const padRight = width >= 360 ? 60 : 8;
    const layout = trendsLayout(rows, {
      width,
      gutter,
      padRight,
      padTop: PAD_TOP,
      topHeight: h.top,
      gap: GAP,
      bottomHeight: h.bottom,
      padBottom: PAD_BOTTOM,
    });
    const plot = layout.top.box;
    const slots = xLabelSlots(count, Math.max(2, Math.floor(plot.width / 48)));
    const selectedIdx = rows.flatMap((r, i) => (selected.includes(r.month) ? [i] : []));
    return {
      layout,
      topLabels,
      bottomLabels,
      colWidth: columnWidth(count, layout.bottom.box),
      endLabels: padRight > 8,
      band: selectedIdx.length
        ? rangeBand(selectedIdx[0]!, selectedIdx.at(-1)!, count, plot)
        : null,
      xLabels: slots.map((slot) => {
        const iso = rows[slot]!.month;
        const withYear = slot === 0 || iso.slice(5, 7) === '01';
        return {
          slot,
          text: withYear ? formatMonthYear(iso, locale) : formatMonthOnly(iso, locale),
        };
      }),
    };
  }, [width, wide, rows, selected, count, currency, locale, formatMoney]);

  const money = (minor: number) => formatMoney(minor, currency, locale);
  const signed = (minor: number) =>
    signedMoney(formatMoney, minor, currency, locale, { plus: true });
  const income = signedMoney(formatMoney, active.income, currency, locale, { plus: true });
  const expense = signedMoney(formatMoney, -active.expense, currency, locale);
  const monthText = formatMonthShort(active.month, locale, true);
  const valueText = t('valueText', {
    month: formatMonthTitle(active.month, locale),
    income,
    expense,
    saving: signed(active.saving),
    net: signed(active.net),
  });
  const first = rows[0]!;
  const last = rows.at(-1)!;
  const negativeMonths = rows.filter((r) => r.saving < 0).length;
  const summary = [
    t('summary', {
      from: formatMonthTitle(first.month, locale),
      to: formatMonthTitle(last.month, locale),
      inFirst: money(first.income),
      inLast: money(last.income),
      outFirst: money(first.expense),
      outLast: money(last.expense),
      saving: signed(rows.reduce((a, r) => a + r.saving, 0)),
    }),
    negativeMonths > 0 ? t('negativeMonths', { count: negativeMonths }) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const noSavingLines =
    rows.every((r) => r.saving === 0) && rows.some((r) => r.income !== 0 || r.expense !== 0);

  const pick = (clientX: number) => {
    if (!geo || !frame) return;
    const box = geo.layout.top.box;
    const x = clientX - frame.getBoundingClientRect().left - box.left;
    const i = Math.min(Math.max(Math.floor(x / (box.width / count)), 0), count - 1);
    setActiveMonth(rows[i]!.month);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next = stepIndex(index, e.key, count);
    if (next === null) return;
    e.preventDefault();
    setActiveMonth(rows[next]!.month);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || e.buttons > 0) pick(e.clientX);
  };

  const showMarkers = count <= 12;
  const liveSlot = live ? count - 1 : -1;

  return (
    <figure data-testid="insights-trends-chart" className="grid grid-cols-1 min-w-0 gap-2">
      <figcaption className="sr-only">{summary}</figcaption>
      <Legend showBand={geo?.band != null} />
      <div className="flex min-h-11 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div aria-hidden="true" className="grid grid-cols-1 min-w-0 gap-0.5 text-sm tabular-nums">
          <p data-testid="trends-readout" className="text-base font-medium">
            {t('readout1', { month: monthText, income, expense })}
          </p>
          <p className="text-muted-foreground">
            {t('readout2', { saving: signed(active.saving), net: signed(active.net) })}
          </p>
        </div>
        {index !== count - 1 ? (
          <button
            type="button"
            onClick={() => setActiveMonth(null)}
            className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
          >
            {common('latest')}
          </button>
        ) : null}
      </div>

      <div ref={setFrame} className="relative w-full min-w-0" style={{ height: frameHeight }}>
        {geo ? (
          <>
            <svg
              aria-hidden="true"
              width="100%"
              height="100%"
              viewBox={`0 0 ${width} ${frameHeight}`}
              className="absolute inset-0 block"
            >
              {geo.band
                ? [geo.layout.top.box, geo.layout.bottom.box].map((box) => (
                    <rect
                      key={box.top}
                      x={geo.band!.x}
                      width={geo.band!.width}
                      y={box.top}
                      height={box.height}
                      className="fill-surface-2"
                    />
                  ))
                : null}
              {geo.topLabels.map((tick) => (
                <g key={`t${tick.value}`}>
                  <line
                    x1={geo.layout.top.box.left}
                    x2={geo.layout.top.box.left + geo.layout.top.box.width}
                    y1={geo.layout.top.yOf(tick.value)}
                    y2={geo.layout.top.yOf(tick.value)}
                    {...CHART_GRID}
                  />
                  <text
                    x={geo.layout.top.box.left - 8}
                    y={geo.layout.top.yOf(tick.value)}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={12}
                    className="fill-muted-foreground tabular-nums"
                  >
                    {tick.text}
                  </text>
                </g>
              ))}
              {geo.bottomLabels.map((tick) => (
                <g key={`b${tick.value}`}>
                  {tick.value === 0 ? null : (
                    <line
                      x1={geo.layout.bottom.box.left}
                      x2={geo.layout.bottom.box.left + geo.layout.bottom.box.width}
                      y1={geo.layout.bottom.yOf(tick.value)}
                      y2={geo.layout.bottom.yOf(tick.value)}
                      {...CHART_GRID}
                    />
                  )}
                  <text
                    x={geo.layout.bottom.box.left - 8}
                    y={geo.layout.bottom.yOf(tick.value)}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={12}
                    className="fill-muted-foreground tabular-nums"
                  >
                    {tick.text}
                  </text>
                </g>
              ))}
              {geo.xLabels.map((label) => (
                <text
                  key={label.slot}
                  x={geo.layout.xs[label.slot]}
                  y={frameHeight - 6}
                  textAnchor="middle"
                  fontSize={12}
                  className="fill-muted-foreground"
                >
                  {label.text}
                </text>
              ))}

              {/* Bottom panel: saving columns from the zero line, a negative one hangs below it. */}
              {geo.layout.bottom.columns.map((c, i) => {
                const hollow = live && i === count - 1;
                return c.height === 0 ? null : (
                  <path
                    key={rows[i]!.month}
                    d={columnPath(c)}
                    className={hollow ? 'fill-surface stroke-chart-2' : 'fill-chart-2'}
                    strokeWidth={hollow ? 1.5 : 0}
                  />
                );
              })}
              <line
                x1={geo.layout.bottom.box.left}
                x2={geo.layout.bottom.box.left + geo.layout.bottom.box.width}
                y1={geo.layout.bottom.zeroY}
                y2={geo.layout.bottom.zeroY}
                className="stroke-input"
                strokeWidth={1}
              />

              <line
                x1={geo.layout.xs[index]}
                x2={geo.layout.xs[index]}
                y1={geo.layout.top.box.top}
                y2={geo.layout.bottom.box.top + geo.layout.bottom.box.height}
                className="stroke-muted-foreground"
                strokeWidth={1}
                strokeDasharray="3 3"
              />

              {/* Top panel: income and expense lines on a zero-based scale, each over a fading area.
                  The month in progress is dashed with a hollow marker and gets no area: still open. */}
              <defs>
                <AreaGradient id={`${gradientId}-income`} color="var(--positive)" strength={0.2} />
                <AreaGradient id={`${gradientId}-expense`} color="var(--chart-1)" strength={0.2} />
              </defs>
              {(
                [
                  ['income', geo.layout.top.income, 'stroke-positive'],
                  ['expense', geo.layout.top.expense, 'stroke-chart-1'],
                ] as const
              ).map(([key, points, cls]) => {
                const paths = buildPaths(points, liveSlot);
                const floor = geo.layout.top.box.top + geo.layout.top.box.height;
                return (
                  <g key={key}>
                    {paths.solid.map((run, i) => (
                      <polygon
                        key={`area-${i}`}
                        points={[
                          ...run.map((p) => `${p.x},${p.y}`),
                          `${run.at(-1)!.x},${floor}`,
                          `${run[0]!.x},${floor}`,
                        ].join(' ')}
                        fill={`url(#${gradientId}-${key})`}
                      />
                    ))}
                    {paths.solid.map((run, i) => (
                      <polyline
                        key={i}
                        points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        className={cls}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ))}
                    {paths.dashed ? (
                      <polyline
                        points={paths.dashed.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        className={cls}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeDasharray="4 3"
                      />
                    ) : null}
                  </g>
                );
              })}
              {rows.map((r, i) => {
                const hollow = live && i === count - 1;
                const isActive = i === index;
                if (!showMarkers && !isActive && i !== 0 && i !== count - 1) return null;
                const inc = geo.layout.top.income[i]!;
                const exp = geo.layout.top.expense[i]!;
                const half = isActive ? 5 : 3;
                return (
                  <g key={r.month}>
                    <circle
                      cx={inc.x}
                      cy={inc.y}
                      r={isActive ? 5 : 3}
                      strokeWidth={hollow || isActive ? 2 : 0}
                      className={
                        hollow
                          ? 'fill-surface stroke-positive'
                          : isActive
                            ? 'fill-positive stroke-surface'
                            : 'fill-positive'
                      }
                    />
                    <rect
                      x={exp.x - half}
                      y={exp.y - half}
                      width={half * 2}
                      height={half * 2}
                      strokeWidth={hollow || isActive ? 2 : 0}
                      className={
                        hollow
                          ? 'fill-surface stroke-chart-1'
                          : isActive
                            ? 'fill-chart-1 stroke-surface'
                            : 'fill-chart-1'
                      }
                    />
                  </g>
                );
              })}
              {geo.endLabels
                ? (() => {
                    const lastX =
                      geo.layout.xs[count - 1]! + geo.layout.top.box.width / count / 2 + 6;
                    // 16px apart at least (12px text), and never past the panel's edges.
                    const box = geo.layout.top.box;
                    const [yIn, yOut] = endLabelYs(
                      geo.layout.top.income[count - 1]!.y,
                      geo.layout.top.expense[count - 1]!.y,
                      16,
                      [box.top + 6, box.top + box.height - 6],
                    );
                    return (
                      <>
                        <text
                          x={lastX}
                          y={yIn}
                          dy="0.32em"
                          fontSize={12}
                          className="fill-foreground"
                        >
                          {t('income')}
                        </text>
                        <text
                          x={lastX}
                          y={yOut}
                          dy="0.32em"
                          fontSize={12}
                          className="fill-foreground"
                        >
                          {t('expense')}
                        </text>
                      </>
                    );
                  })()
                : null}
            </svg>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute text-sm text-muted-foreground"
              style={{ left: geo.layout.top.box.left, top: 0 }}
            >
              {t('panelTop')}
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute text-sm text-muted-foreground"
              style={{ left: geo.layout.bottom.box.left, top: geo.layout.bottom.box.top - PAD_TOP }}
            >
              {t('panelBottom')}
            </div>
            <div
              role="slider"
              tabIndex={0}
              aria-label={t('slider')}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={count - 1}
              aria-valuenow={index}
              aria-valuetext={valueText}
              onKeyDown={onKeyDown}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                pick(e.clientX);
              }}
              onPointerMove={onPointerMove}
              className="absolute inset-0 cursor-crosshair touch-pan-y rounded-md"
            />
          </>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-1 text-sm text-muted-foreground">
        {negativeMonths > 0 ? <p>{t('negativeNote')}</p> : null}
        {noSavingLines ? <p>{t('noSavingLines')}</p> : null}
        {live ? <p>{t('live')}</p> : null}
      </div>
    </figure>
  );
}

/**
 * "Evolução em 12 meses": income and spending as two lines (top) and saving as columns from a
 * zero line (bottom), on one month axis with one slider. The selected period of the page is
 * shaded behind the months. The SVG is hidden from assistive technology: the caption and the
 * slider's value text say the same, and the table view lists every month.
 */
export function TrendsChart({
  rows,
  selected,
  currentMonth,
  title,
}: {
  /** The twelve months, oldest first, leading empty months already dropped. */
  rows: TrendRow[];
  /** The months of the page's period (`yyyy-mm-01`). */
  selected: readonly string[];
  currentMonth: string;
  title: string;
}) {
  const t = useTranslations('insights.trends');
  const { locale } = useHouseholdFormat();
  return (
    <SectionCard testId="insights-trends" title={title} toggle={rows.length > 0}>
      {(view) =>
        rows.length === 0 ? (
          <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t('empty')}
          </div>
        ) : view === 'table' ? (
          <TrendsTable rows={rows} selected={selected} currentMonth={currentMonth} />
        ) : rows.length === 1 ? (
          <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t('single', {
              month: formatMonthTitle(rows[0]!.month, locale).toLocaleLowerCase(locale),
            })}
          </div>
        ) : (
          <TrendsPlot rows={rows} selected={selected} currentMonth={currentMonth} />
        )
      }
    </SectionCard>
  );
}
