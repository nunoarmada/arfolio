'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { formatMonthShort } from '@/lib/dates';
import {
  barShare,
  columnsInBox,
  gutterWidth,
  insightsHref,
  txHref,
  type InsightsParams,
} from '@/lib/insights-chart';
import { signedMoney } from '@/lib/insights-format';
import { stepIndex, xLabelSlots } from '@/lib/net-worth-chart';
import { formatMonthOnly, formatMonthTitle, formatMonthYear } from '@/lib/net-worth-format';
import type { InsightsCashFlow } from '@/server/insights-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { CHART_GRID } from '../charts/chart-primitives';
import { useMedia, useWidth } from '../charts/use-chart-frame';
import { Alert } from '../ui/alert';
import { Select } from '../ui/select';
import { ROW_HEAD, SectionCard, TableRegion, TH, TH_FIRST } from './section-card';
import { useFormatMoney } from '@/components/privacy';

type Ready = Extract<InsightsCashFlow, { kind: 'ready' }>;

const MINUS = '−';
const PAD = { top: 12, right: 8, bottom: 24 };

/** Net per month: columns from a zero line (a deficit hangs below it), one slider, one readout. */
/** The period's totals as the service sums them. */
type Totals = Pick<Ready, 'inflow' | 'outflow' | 'net'>;

function NetByMonth({
  months,
  totals,
  currentMonth,
}: {
  months: Ready['byMonth'];
  totals: Totals;
  currentMonth: string;
}) {
  const t = useTranslations('insights.cashFlow');
  const common = useTranslations('insights');
  const trends = useTranslations('insights.trends');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const width = useWidth(frame);
  const wide = useMedia('(min-width: 768px)');
  const height = wide ? 180 : 160;
  const count = months.length;
  const found = activeMonth === null ? -1 : months.findIndex((m) => m.month === activeMonth);
  const index = found >= 0 ? found : count - 1;
  const active = months[index]!;
  const live = months.at(-1)!.month === currentMonth;
  const signed = (minor: number) =>
    signedMoney(formatMoney, minor, currency, locale, { plus: true });

  const geo = useMemo(() => {
    if (width === 0) return null;
    const nets = months.map((m) => m.net);
    const probe = columnsInBox(nets, {
      left: 0,
      width: 1,
      top: PAD.top,
      height: height - PAD.top - PAD.bottom,
    });
    const labels = probe.scale.ticks.map((value) => ({
      value,
      text: `${value < 0 ? MINUS : ''}${formatMoney(Math.abs(value), currency, locale, { compact: true })}`,
    }));
    const left = gutterWidth(labels.map((l) => l.text));
    const box = {
      left,
      width: Math.max(width - left - PAD.right, 1),
      top: PAD.top,
      height: height - PAD.top - PAD.bottom,
    };
    const plot = columnsInBox(nets, box);
    const slots = xLabelSlots(count, Math.max(2, Math.floor(box.width / 48)));
    return {
      box,
      ...plot,
      labels,
      xLabels: slots.map((slot) => {
        const iso = months[slot]!.month;
        const withYear = slot === 0 || iso.slice(5, 7) === '01';
        return {
          slot,
          x: box.left + ((slot + 0.5) * box.width) / count,
          text: withYear ? formatMonthYear(iso, locale) : formatMonthOnly(iso, locale),
        };
      }),
    };
  }, [width, height, months, count, currency, locale, formatMoney]);

  const readout = t('readout', {
    month: formatMonthShort(active.month, locale, true),
    in: signed(active.inflow),
    out: signedMoney(formatMoney, -active.outflow, currency, locale),
    net: signed(active.net),
  });
  const first = months[0]!;
  const last = months.at(-1)!;

  const pick = (clientX: number) => {
    if (!geo || !frame) return;
    const x = clientX - frame.getBoundingClientRect().left - geo.box.left;
    const i = Math.min(Math.max(Math.floor(x / (geo.box.width / count)), 0), count - 1);
    setActiveMonth(months[i]!.month);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next = stepIndex(index, e.key, count);
    if (next === null) return;
    e.preventDefault();
    setActiveMonth(months[next]!.month);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' || e.buttons > 0) pick(e.clientX);
  };

  return (
    <figure data-testid="cashflow-by-month" className="grid grid-cols-1 min-w-0 gap-2">
      <figcaption className="sr-only">
        {t('summary', {
          from: formatMonthTitle(first.month, locale),
          to: formatMonthTitle(last.month, locale),
          in: signed(totals.inflow),
          out: signedMoney(formatMoney, -totals.outflow, currency, locale),
          net: signed(totals.net),
        })}
      </figcaption>
      <div className="flex min-h-11 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p
          aria-hidden="true"
          data-testid="cashflow-readout"
          className="min-w-0 text-base font-medium tabular-nums"
        >
          {readout}
        </p>
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
      <div ref={setFrame} className="relative w-full min-w-0" style={{ height }}>
        {geo ? (
          <>
            <svg
              aria-hidden="true"
              width="100%"
              height="100%"
              viewBox={`0 0 ${width} ${height}`}
              className="absolute inset-0 block"
            >
              {geo.labels.map((tick) => (
                <g key={tick.value}>
                  {tick.value === 0 ? null : (
                    <line
                      x1={geo.box.left}
                      x2={geo.box.left + geo.box.width}
                      y1={geo.yOf(tick.value)}
                      y2={geo.yOf(tick.value)}
                      {...CHART_GRID}
                    />
                  )}
                  <text
                    x={geo.box.left - 8}
                    y={geo.yOf(tick.value)}
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
                  x={label.x}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize={12}
                  className="fill-muted-foreground"
                >
                  {label.text}
                </text>
              ))}
              {geo.columns.map((c, i) => {
                const hollow = live && i === count - 1;
                return c.height === 0 ? null : (
                  <rect
                    key={months[i]!.month}
                    x={c.x}
                    y={c.y}
                    width={c.width}
                    height={c.height}
                    rx={2}
                    className={hollow ? 'fill-surface stroke-chart-4' : 'fill-chart-4'}
                    strokeWidth={hollow ? 1.5 : 0}
                  />
                );
              })}
              <line
                x1={geo.box.left}
                x2={geo.box.left + geo.box.width}
                y1={geo.zeroY}
                y2={geo.zeroY}
                className="stroke-input"
                strokeWidth={1}
              />
              <line
                x1={geo.box.left + ((index + 0.5) * geo.box.width) / count}
                x2={geo.box.left + ((index + 0.5) * geo.box.width) / count}
                y1={geo.box.top}
                y2={geo.box.top + geo.box.height}
                className="stroke-muted-foreground"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            </svg>
            <div
              role="slider"
              tabIndex={0}
              aria-label={t('slider')}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={count - 1}
              aria-valuenow={index}
              aria-valuetext={readout}
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
      {live ? <p className="text-sm text-muted-foreground">{trends('live')}</p> : null}
    </figure>
  );
}

/**
 * "Fluxo de caixa": what came in and went out in the period, as three figures; the net per month
 * (periods of 3 or 12 months); and, across all accounts, each account's in and out as two bars.
 * Transfers between the household's own accounts never count.
 */
export function CashFlow({
  data,
  params,
  from,
  to,
  currentMonth,
  title,
}: {
  data: Ready;
  params: InsightsParams;
  from: string;
  to: string;
  currentMonth: string;
  title: string;
}) {
  const t = useTranslations('insights.cashFlow');
  const common = useTranslations('insights');
  const router = useRouter();
  const selectId = useId();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);

  const empty = data.inflow === 0 && data.outflow === 0;
  const byMonth = params.range >= 3;
  const showAccounts = data.account === null && data.byAccount.length > 0;
  const largest = Math.max(...data.byAccount.flatMap((a) => [a.inflow, a.outflow]), 0);
  const monthsLabel = t('captionMonth');
  const accountsLabel = t('captionAccount');

  return (
    <SectionCard testId="insights-cashflow" title={title} toggle={!empty}>
      {(view) => (
        <>
          <div className="grid grid-cols-1 gap-1">
            <label htmlFor={selectId} className="text-sm font-medium">
              {t('account')}
            </label>
            <div className="w-full md:max-w-[220px]">
              <Select
                id={selectId}
                value={data.account ?? ''}
                onChange={(e) =>
                  router.replace(
                    insightsHref({ ...params, account: e.target.value || null }, currentMonth),
                    { scroll: false },
                  )
                }
              >
                <option value="">{t('allAccounts')}</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
            {data.hasForeignAccounts ? (
              <p className="text-sm text-muted-foreground">{t('foreignAccounts')}</p>
            ) : null}
          </div>

          {data.foreignCount > 0 ? (
            <Alert tone="info" className="bg-surface-2">
              {common('foreign', { count: data.foreignCount })}
            </Alert>
          ) : null}

          {empty ? (
            <p className="text-base text-muted-foreground">{t('empty')}</p>
          ) : (
            <>
              <dl className="grid grid-cols-1 gap-2 @sm:grid-cols-3 @sm:gap-3">
                {(
                  [
                    ['in', data.inflow, 'income'],
                    ['out', data.outflow, 'expense'],
                    ['net', data.net, 'balance'],
                  ] as const
                ).map(([key, value, kind]) => (
                  <div
                    key={key}
                    data-testid={`cashflow-${key}`}
                    className="flex items-baseline justify-between gap-3 @sm:block"
                  >
                    <dt className="text-sm text-muted-foreground">{t(key)}</dt>
                    <dd>
                      <MoneyAmount minor={value} currency={currency} kind={kind} />
                    </dd>
                  </div>
                ))}
              </dl>

              {view === 'table' ? (
                <div data-testid="insights-cashflow-table" className="grid grid-cols-1 gap-4">
                  <TableRegion label={monthsLabel} testId="cashflow-month-table" compact>
                    <thead className="bg-surface-2">
                      <tr>
                        <th scope="col" className={cn(TH_FIRST, 'px-2')}>
                          {common('trends.col.month')}
                        </th>
                        <th scope="col" className={cn(TH, 'px-2 text-right')}>
                          {t('in')}
                        </th>
                        <th scope="col" className={cn(TH, 'px-2 text-right')}>
                          {t('out')}
                        </th>
                        <th scope="col" className={cn(TH, 'px-2 text-right')}>
                          {t('col.net')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {[...data.byMonth].reverse().map((m) => (
                        <tr key={m.month} data-month={m.month.slice(0, 7)} className="bg-surface">
                          <th scope="row" className={cn(ROW_HEAD, 'px-2')}>
                            {formatMonthShort(m.month, locale, true)}
                            {m.month === currentMonth ? ` (${common('inProgress')})` : ''}
                          </th>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={m.inflow}
                              currency={currency}
                              kind="income"
                              size="sm"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={m.outflow}
                              currency={currency}
                              kind="expense"
                              size="sm"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={m.net}
                              currency={currency}
                              kind="balance"
                              size="sm"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableRegion>
                  {showAccounts ? (
                    <TableRegion label={accountsLabel} testId="cashflow-account-table" compact>
                      <thead className="bg-surface-2">
                        <tr>
                          <th scope="col" className={cn(TH_FIRST, 'px-2')}>
                            {t('account')}
                          </th>
                          <th scope="col" className={cn(TH, 'px-2 text-right')}>
                            {t('in')}
                          </th>
                          <th scope="col" className={cn(TH, 'px-2 text-right')}>
                            {t('out')}
                          </th>
                          <th scope="col" className={cn(TH, 'px-2 text-right')}>
                            {t('col.net')}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.byAccount.map((a) => (
                          <tr key={a.accountId} className="bg-surface">
                            <th scope="row" className={cn(ROW_HEAD, 'px-2')}>
                              {a.name}
                            </th>
                            <td className="px-2 py-2 text-right">
                              <MoneyAmount
                                minor={a.inflow}
                                currency={currency}
                                kind="income"
                                size="sm"
                              />
                            </td>
                            <td className="px-2 py-2 text-right">
                              <MoneyAmount
                                minor={a.outflow}
                                currency={currency}
                                kind="expense"
                                size="sm"
                              />
                            </td>
                            <td className="px-2 py-2 text-right">
                              <MoneyAmount
                                minor={a.inflow - a.outflow}
                                currency={currency}
                                kind="balance"
                                size="sm"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-border-strong bg-surface-2">
                          <th
                            scope="row"
                            className={cn(ROW_HEAD, 'bg-surface-2 px-2 font-semibold')}
                          >
                            {t('col.total')}
                          </th>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={data.inflow}
                              currency={currency}
                              kind="income"
                              size="sm"
                              className="font-semibold"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={data.outflow}
                              currency={currency}
                              kind="expense"
                              size="sm"
                              className="font-semibold"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <MoneyAmount
                              minor={data.net}
                              currency={currency}
                              kind="balance"
                              size="sm"
                              className="font-semibold"
                            />
                          </td>
                        </tr>
                      </tfoot>
                    </TableRegion>
                  ) : null}
                </div>
              ) : (
                <>
                  {byMonth ? (
                    <div className="grid grid-cols-1 gap-1">
                      <h3 className="text-base font-semibold">{t('byMonth')}</h3>
                      <NetByMonth months={data.byMonth} totals={data} currentMonth={currentMonth} />
                    </div>
                  ) : null}
                  {showAccounts ? (
                    <div className="grid grid-cols-1 gap-1">
                      <h3 className="text-base font-semibold">{t('byAccount')}</h3>
                      <ul className="grid grid-cols-1">
                        {data.byAccount.map((a) => (
                          <li key={a.accountId}>
                            <Link
                              href={txHref({ from, to, accountId: a.accountId })}
                              data-testid="cashflow-account-row"
                              data-account-id={a.accountId}
                              aria-label={t('accountLink', {
                                account: a.name,
                                in: money(a.inflow),
                                out: money(a.outflow),
                              })}
                              className="grid grid-cols-1 min-h-16 content-center gap-1.5 rounded-md py-2 hover:bg-surface-2"
                            >
                              <span className="flex items-center gap-2">
                                <span className="line-clamp-2 min-w-0 flex-1 break-words text-base font-medium">
                                  {a.name}
                                </span>
                                <MoneyAmount
                                  minor={a.inflow - a.outflow}
                                  currency={currency}
                                  kind="balance"
                                />
                                <ChevronRight
                                  aria-hidden="true"
                                  className="size-5 shrink-0 text-muted-foreground"
                                />
                              </span>
                              <span aria-hidden="true" className="grid grid-cols-1 gap-0.5">
                                {(
                                  [
                                    [
                                      'bg-positive',
                                      a.inflow,
                                      a.inflow > 0 ? `+${money(a.inflow)}` : money(0),
                                    ],
                                    [
                                      'bg-chart-1',
                                      a.outflow,
                                      a.outflow > 0 ? `${MINUS}${money(a.outflow)}` : money(0),
                                    ],
                                  ] as const
                                ).map(([color, value, text]) => (
                                  <span key={color} className="flex flex-wrap items-center gap-x-2">
                                    <span className="block h-1.5 min-w-16 flex-1">
                                      <span
                                        className={cn('block h-full rounded-full', color)}
                                        style={{
                                          width: `${barShare(value, largest) * 100}%`,
                                          minWidth: value > 0 ? 2 : 0,
                                        }}
                                      />
                                    </span>
                                    <span className="text-sm tabular-nums">{text}</span>
                                  </span>
                                ))}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                      {data.idleAccounts > 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t('idle', { count: data.idleAccounts })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}
