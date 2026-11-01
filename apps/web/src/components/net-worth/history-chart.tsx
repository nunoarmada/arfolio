'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  buildPaths,
  missingMonths,
  nearestIndex,
  placeRows,
  stepIndex,
  xLabelSlots,
  yScale,
  shiftMonth,
  type ChartRow,
  type ScalePoint,
} from '@/lib/net-worth-chart';
import { formatMonthOnly, formatMonthTitle, formatMonthYear } from '@/lib/net-worth-format';
import { gutterWidth } from '@/lib/insights-chart';
import { useHouseholdFormat } from '../household-format';
import {
  AreaGradient,
  CHART_AXIS_TEXT,
  CHART_GRID,
  CHART_SERIES,
} from '../charts/chart-primitives';
import { useMedia, useWidth } from '../charts/use-chart-frame';
import { useChangeSentence, type Change } from './change-label';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';
const PAD = { right: 12, top: 12, bottom: 24 };

/** 200 on phones, 240 on tablets, 280 on desktop (beside the headline), 160 compact. */
function useChartHeight(compact: boolean): number {
  const md = useMedia('(min-width: 768px)');
  const lg = useMedia('(min-width: 1024px)');
  if (compact) return md ? 220 : 180;
  return lg ? 280 : md ? 240 : 200;
}

const changeOf = (points: readonly ScalePoint[], i: number): Change => {
  const p = points[i]!;
  const prev = points[i - 1];
  if (p.change === null || !prev) return { kind: 'first' };
  return {
    kind: p.change > 0 ? 'up' : p.change < 0 ? 'down' : 'flat',
    amount: Math.abs(p.change),
    prevMonth: prev.month,
  };
};

/**
 * Net worth per month as a single hand-drawn SVG line: no fill (the axis does not start at zero),
 * a missing month breaks the line, the live month is dashed and hollow. A readout above the plot
 * shows the active month; a slider (pointer, touch or keyboard) moves between existing months.
 * The SVG is hidden from assistive technology: the slider's value text and the figure caption
 * carry the same information.
 */
export function HistoryChart({
  rows,
  scale,
  currentMonth,
  compact = false,
  caption = true,
  record,
}: {
  rows: ChartRow[];
  scale: { start: string; count: number };
  currentMonth: string;
  compact?: boolean;
  /** The "current month is live" line under the plot. */
  caption?: boolean;
  /** A single record's values (a detail page): names it instead of the household's net worth. */
  record?: string;
}) {
  const t = useTranslations('netWorthChart');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const sentence = useChangeSentence(currentMonth);
  const gradientId = useId();
  const points = useMemo(() => placeRows(rows, scale), [rows, scale]);
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const width = useWidth(frame);
  const height = useChartHeight(compact);

  const found = activeMonth === null ? -1 : points.findIndex((p) => p.month === activeMonth);
  const index = found >= 0 ? found : points.length - 1;
  const active = points[index];

  const money = (minor: number) => formatMoney(Math.abs(minor), currency, locale);
  const signed = (minor: number) => `${minor < 0 ? MINUS : ''}${money(minor)}`;
  const monthTitle = (iso: string) => formatMonthTitle(iso, locale);

  const geo = useMemo(() => {
    if (width === 0 || points.length < 2) return null;
    const y = yScale(points.map((p) => p.net));
    const labels = y.ticks.map((tick) => ({
      value: tick,
      text: `${tick < 0 ? MINUS : ''}${formatMoney(Math.abs(tick), currency, locale, { compact: true })}`,
    }));
    const left = gutterWidth(labels.map((l) => l.text));
    const plotW = Math.max(width - left - PAD.right, 1);
    const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
    const xOf = (slot: number) => left + (slot / (scale.count - 1)) * plotW;
    const yOf = (v: number) => PAD.top + (1 - (v - y.min) / (y.max - y.min)) * plotH;
    const placed = points.map((p) => ({ ...p, x: xOf(p.slot), y: yOf(p.net) }));
    const slots = xLabelSlots(scale.count, Math.max(2, Math.min(12, Math.floor(plotW / 64))));
    return {
      y,
      labels,
      left,
      plotW,
      plotH,
      xOf,
      yOf,
      placed,
      paths: buildPaths(placed, scale.count - 1),
      xLabels: slots.map((slot) => {
        const iso = shiftMonth(scale.start, slot);
        const withYear = slot === 0 || iso.slice(5, 7) === '01';
        return {
          slot,
          text: withYear ? formatMonthYear(iso, locale) : formatMonthOnly(iso, locale),
        };
      }),
    };
  }, [width, height, points, scale, currency, locale, formatMoney]);

  if (!active) return null;

  if (points.length < 2) {
    return (
      <figure data-testid="net-worth-chart" className="grid grid-cols-1 min-w-0 gap-2">
        <figcaption className="sr-only">
          {t('summary', {
            from: monthTitle(active.month),
            to: monthTitle(active.month),
            first: signed(active.net),
            last: signed(active.net),
          })}
        </figcaption>
        <div className="flex h-[120px] items-center justify-center rounded-lg bg-surface-2 p-4 text-center text-sm text-muted-foreground">
          {t('single')}
        </div>
      </figure>
    );
  }

  const first = points[0]!;
  const last = points.at(-1)!;
  const gaps = missingMonths(points, scale).length;
  const activeChange = changeOf(points, index);
  const valueText = t('valueText', {
    month: monthTitle(active.month),
    net: signed(active.net),
    change: sentence(activeChange),
  });
  const summaryValues = {
    from: monthTitle(first.month),
    to: monthTitle(last.month),
    first: signed(first.net),
    last: signed(last.net),
  };
  const summary = [
    record ? t('recordSummary', { name: record, ...summaryValues }) : t('summary', summaryValues),
    sentence(changeOf(points, points.length - 1)),
    gaps > 0 ? t('gapsSummary', { count: gaps }) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const showAllMarkers = points.length <= 12;
  const live = last.month === currentMonth;

  const pick = (clientX: number) => {
    if (!geo || !frame) return;
    const rect = frame.getBoundingClientRect();
    const slot = ((clientX - rect.left - geo.left) / geo.plotW) * (scale.count - 1);
    const next =
      points[
        nearestIndex(
          points.map((p) => p.slot),
          slot,
        )
      ];
    if (next) setActiveMonth(next.month);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next = stepIndex(index, e.key, points.length);
    if (next === null) return;
    e.preventDefault();
    setActiveMonth(points[next]!.month);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || e.buttons > 0) pick(e.clientX);
  };

  const ActiveArrow = activeChange.kind === 'up' ? ArrowUpRight : ArrowDownRight;

  return (
    <figure data-testid="net-worth-chart" className="grid grid-cols-1 min-w-0 gap-2">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="flex min-h-11 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div aria-hidden="true" className="grid grid-cols-1 min-w-0 gap-0.5">
          <p className="flex flex-wrap items-center gap-x-2 text-base font-semibold tabular-nums">
            <span data-testid="chart-readout">
              {t('readout', { month: monthTitle(active.month), net: signed(active.net) })}
            </span>
            {activeChange.kind === 'up' || activeChange.kind === 'down' ? (
              <span
                className={`inline-flex items-center gap-0.5 ${
                  activeChange.kind === 'up' ? 'text-positive' : 'text-muted-foreground'
                }`}
              >
                <ActiveArrow className="size-4" />
                {activeChange.kind === 'up' ? '+' : MINUS}
                {money(activeChange.amount)}
              </span>
            ) : null}
          </p>
          {compact ? null : (
            <p className="text-sm tabular-nums text-muted-foreground">
              {t('readoutParts', {
                assets: money(active.assets),
                liabilities: money(active.liabilities),
              })}
            </p>
          )}
        </div>
        {index !== points.length - 1 ? (
          <button
            type="button"
            onClick={() => setActiveMonth(null)}
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary-text underline-offset-4 hover:underline"
          >
            {t('latest')}
          </button>
        ) : null}
      </div>

      <div ref={setFrame} className="relative w-full min-w-0 overflow-hidden" style={{ height }}>
        {geo ? (
          <>
            <svg
              aria-hidden="true"
              width="100%"
              height="100%"
              viewBox={`0 0 ${width} ${height}`}
              className="absolute inset-0 block"
            >
              <defs>
                <AreaGradient id={gradientId} />
              </defs>
              {geo.paths.solid.map((run, i) =>
                run.length > 1 ? (
                  <polygon
                    key={`area-${i}`}
                    points={[
                      ...run.map((p) => `${p.x},${p.y}`),
                      `${run.at(-1)!.x},${height - PAD.bottom}`,
                      `${run[0]!.x},${height - PAD.bottom}`,
                    ].join(' ')}
                    fill={`url(#${gradientId})`}
                  />
                ) : null,
              )}
              {geo.labels.map((tick) => (
                <g key={tick.value}>
                  <line
                    x1={geo.left}
                    x2={width - PAD.right}
                    y1={geo.yOf(tick.value)}
                    y2={geo.yOf(tick.value)}
                    {...(geo.y.spansZero && tick.value === 0
                      ? { className: 'stroke-border-strong', strokeWidth: 1 }
                      : CHART_GRID)}
                  />
                  <text
                    x={geo.left - 8}
                    y={geo.yOf(tick.value)}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={12}
                    className={CHART_AXIS_TEXT}
                  >
                    {tick.text}
                  </text>
                </g>
              ))}
              {geo.xLabels.map((label, i) => (
                <text
                  key={label.slot}
                  x={geo.xOf(label.slot)}
                  y={height - 6}
                  textAnchor={i === geo.xLabels.length - 1 ? 'end' : 'middle'}
                  fontSize={12}
                  className={CHART_AXIS_TEXT}
                >
                  {label.text}
                </text>
              ))}
              <line
                x1={geo.placed[index]!.x}
                x2={geo.placed[index]!.x}
                y1={PAD.top}
                y2={height - PAD.bottom}
                className="stroke-muted-foreground/60"
                strokeWidth={1}
              />
              {geo.paths.solid.map((run, i) => (
                <polyline
                  key={i}
                  points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                  {...CHART_SERIES}
                />
              ))}
              {geo.paths.dashed ? (
                <polyline
                  points={geo.paths.dashed.map((p) => `${p.x},${p.y}`).join(' ')}
                  {...CHART_SERIES}
                  strokeDasharray="4 3"
                />
              ) : null}
              {geo.paths.dots.map((p) => (
                <circle key={`${p.x}`} cx={p.x} cy={p.y} r={3} className="fill-primary" />
              ))}
              {geo.placed.map((p, i) => {
                const isLive = live && i === geo.placed.length - 1;
                const show = showAllMarkers || i === 0 || i === geo.placed.length - 1;
                if (!show || i === index) return null;
                return isLive ? (
                  <circle
                    key={p.month}
                    cx={p.x}
                    cy={p.y}
                    r={4}
                    strokeWidth={2}
                    className="fill-surface stroke-primary"
                  />
                ) : (
                  <circle key={p.month} cx={p.x} cy={p.y} r={3} className="fill-primary" />
                );
              })}
              {live && index === points.length - 1 ? (
                <circle
                  cx={geo.placed[index]!.x}
                  cy={geo.placed[index]!.y}
                  r={5}
                  strokeWidth={2}
                  className="fill-surface stroke-primary"
                />
              ) : (
                <circle
                  cx={geo.placed[index]!.x}
                  cy={geo.placed[index]!.y}
                  r={5}
                  strokeWidth={2}
                  className="fill-primary stroke-surface"
                />
              )}
            </svg>
            <div
              role="slider"
              tabIndex={0}
              aria-label={record ? t('recordSlider') : t('slider')}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={points.length - 1}
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
      {caption && live ? <p className="text-sm text-muted-foreground">{t('live')}</p> : null}
    </figure>
  );
}
