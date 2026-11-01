'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BudgetYearLine, BudgetYearView } from '@arfolio/services';
import {
  favourable,
  formatTenths,
  isOverPlan,
  monthlyAverage,
  monthsElapsed,
  shareTenths,
  type YearShow,
} from '@/lib/budget-grid';
import { truncateName } from '@/lib/budget-import-copy';
import type { BudgetKind } from '@/lib/budget-status';
import { cn } from '@/lib/cn';
import { formatMonthShort } from '@/lib/dates';
import type { BudgetDto } from '@/server/budget-data';
import type { Lookups } from '@/server/lookups';
import { useHouseholdFormat } from '../household-format';
import { buttonVariants } from '../ui/button';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { Sheet } from '../ui/sheet';
import { useFormatMoney } from '@/components/privacy';

const KINDS = ['income', 'expense', 'saving'] as const;
const MINUS = '−';

type Cell = { planned: number; actual: number };
type RowKind = BudgetKind | 'balance';

/** Favourable is positive for every kind; the unallocated row is a balance (actual minus planned). */
const difference = (kind: RowKind, c: Cell): number =>
  kind === 'balance' ? c.actual - c.planned : favourable(kind, c.planned, c.actual);

/** Shadow on the left of the pinned Total column while there is more to scroll to the right. */
const TOTAL_SHADOW =
  'lg:group-data-[end=false]/scroll:shadow-[-1px_0_0_var(--border-strong),-6px_0_8px_-6px_var(--edge-shadow)]';
const HEAD =
  'sticky top-0 z-20 h-10 whitespace-nowrap border-b border-border bg-surface-2 px-3 text-right text-label font-medium text-muted-foreground';
const BODY =
  'h-[52px] whitespace-nowrap border-b border-border px-3 text-right text-sm tabular-nums transition-colors group-hover/row:bg-surface-2';
const NAME_WIDTH =
  'w-[148px] min-w-[148px] max-w-[148px] md:w-[168px] md:min-w-[168px] md:max-w-[168px] lg:w-[200px] lg:min-w-[200px] lg:max-w-[200px]';
/** The yearly total stays in view from lg: it is the number people come to this table for. */
const TOTAL_PIN = 'lg:sticky lg:right-0 lg:z-10';

/**
 * The sheet's twelve-month grid, made legible on a phone: the line names and the header row stay
 * put while the months scroll. Planned, actual and difference share one table.
 */
export function YearGrid({
  budget,
  view,
  lookups,
  show: initialShow,
  todayMonth,
  canWrite,
  backBase,
  leading,
  trailing,
}: {
  budget: BudgetDto;
  view: BudgetYearView;
  lookups: Lookups;
  show: YearShow;
  /** First day of the current month. */
  todayMonth: string;
  canWrite: boolean;
  /** Where the line editor returns to: this page with `?start=` (the view toggle is added). */
  backBase: string;
  /** Start of the toolbar: the budget stepper. */
  leading: ReactNode;
  /** End of the toolbar: the add and "more" actions. */
  trailing: ReactNode;
}) {
  const t = useTranslations('budgetYear');
  const kinds = useTranslations('budget.kinds');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const captionId = useId();
  const [show, setShow] = useState<YearShow>(initialShow);
  const [openId, setOpenId] = useState<string | null>(null);
  const table = useRef<HTMLTableElement>(null);
  const lastOpened = useRef<string | null>(null);

  const groupName = useMemo(() => new Map(lookups.groups.map((g) => [g.id, g.name])), [lookups]);
  const accountName = useMemo(
    () => new Map(lookups.accounts.map((a) => [a.id, a.name])),
    [lookups],
  );
  const months = useMemo(
    () =>
      view.months.map((m) => {
        const date = new Date(`${m.from}T00:00:00Z`);
        const format = (options: Intl.DateTimeFormatOptions) =>
          new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
        return {
          index: m.index,
          key: `${m.from.slice(0, 7)}-01`,
          short: formatMonthShort(m.from, locale),
          long: format({ month: 'long', year: 'numeric' }),
        };
      }),
    [view.months, locale],
  );
  /** Months that have started (the current one included): actuals exist only for these. */
  const started = months.filter((m) => m.key <= todayMonth).length;
  const elapsed = monthsElapsed(budget.startMonth, todayMonth);

  const groupRank = useMemo(() => new Map(lookups.groups.map((g, i) => [g.id, i])), [lookups]);
  const sections = useMemo(
    () =>
      KINDS.map((kind) => ({
        kind,
        lines: view.lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.kind === kind)
          .sort((a, b) => {
            const ra = a.line.groupId ? (groupRank.get(a.line.groupId) ?? 999) : 1000;
            const rb = b.line.groupId ? (groupRank.get(b.line.groupId) ?? 999) : 1000;
            return ra - rb || a.index - b.index;
          })
          .map(({ line }) => line),
      })),
    [view.lines, groupRank],
  );

  useEffect(() => {
    const el = table.current?.parentElement;
    if (!el) return;
    // Phones and tablets: open on the current month with the month before it still in view.
    if (window.matchMedia('(max-width: 1023px)').matches) {
      const current = el.querySelector<HTMLElement>('th[data-current="true"]');
      const first = el.querySelector<HTMLElement>('th[data-first="true"]');
      if (current && first)
        el.scrollLeft = Math.max(0, current.offsetLeft - first.offsetWidth - 96);
    }
  }, []);

  // Coming back from the line editor lands on the line that was edited.
  useEffect(() => {
    const id = window.location.hash.match(/^#line-([0-9a-f-]{36})$/i)?.[1];
    if (!id) return;
    const row = document.getElementById(`line-${id}`);
    row?.scrollIntoView({ block: 'center', inline: 'start' });
    row?.focus({ preventScroll: true });
  }, []);

  function choose(next: YearShow) {
    setShow(next);
    const url = new URL(window.location.href);
    url.searchParams.set('show', next);
    window.history.replaceState(window.history.state, '', url);
  }

  const signed = (minor: number): ReactNode => (
    <span className={minor < 0 ? 'text-negative' : undefined}>
      {minor < 0 ? MINUS : minor > 0 ? '+' : ''}
      {money(Math.abs(minor))}
    </span>
  );

  /** One month's cell for the chosen view; "—" where there is nothing to say. */
  function monthCell(kind: RowKind, c: Cell, isStarted: boolean): ReactNode {
    const dash = (sr: string) => (
      <>
        <span aria-hidden="true" className="text-subtle-foreground">
          —
        </span>
        <span className="sr-only">{sr}</span>
      </>
    );
    if (show === 'planned') {
      return c.planned === 0 ? dash(t('zero')) : money(c.planned);
    }
    if (!isStarted) return dash(t('noData'));
    if (show === 'actual') {
      if (c.actual === 0) return dash(t('zero'));
      return kind === 'balance' && c.actual < 0 ? negativeBalance(c.actual) : money(c.actual);
    }
    if (c.planned === 0 && c.actual === 0) return dash(t('zero'));
    return (
      <>
        {signed(difference(kind, c))}
        {kind === 'balance' && difference(kind, c) < 0 ? (
          <span className="sr-only"> {t('short')}</span>
        ) : null}
      </>
    );
  }

  function negativeBalance(minor: number): ReactNode {
    return (
      <span className="text-negative">
        {MINUS}
        {money(Math.abs(minor))}
        <span className="sr-only"> {t('short')}</span>
      </span>
    );
  }

  /** Total, monthly average and the last column's share, for one row of twelve months. */
  function summary(kind: RowKind, cells: Cell[], total: Cell) {
    const done = cells.slice(0, started);
    const planned = done.reduce((s, c) => s + c.planned, 0);
    const actual = done.reduce((s, c) => s + c.actual, 0);
    if (show === 'planned') {
      return { total: total.planned, average: monthlyAverage(total.planned, 12), planned, actual };
    }
    if (show === 'actual') {
      return {
        total: total.actual,
        average: monthlyAverage(total.actual, elapsed),
        planned,
        actual,
      };
    }
    const diff = difference(kind, { planned, actual });
    return { total: diff, average: monthlyAverage(diff, Math.max(1, started)), planned, actual };
  }

  const amount = (value: number, kind: RowKind): ReactNode =>
    show === 'diff'
      ? signed(value)
      : kind === 'balance' && value < 0
        ? negativeBalance(value)
        : money(value);

  function share(kind: BudgetKind, cells: Cell[], total: Cell, sectionTotal: Cell): string {
    const s = summary(kind, cells, total);
    const tenths =
      show === 'diff'
        ? shareTenths(s.actual, s.planned)
        : shareTenths(
            show === 'planned' ? total.planned : total.actual,
            show === 'planned' ? sectionTotal.planned : sectionTotal.actual,
          );
    return tenths === null ? '—' : formatTenths(tenths, locale);
  }

  const caption = t('caption', { name: budget.name, view: t(`captions.${show}`) });
  const nameCell = (extra?: string) =>
    cn(
      dataTable.stickyFirst,
      'border-b border-border p-0 text-left font-normal transition-colors group-hover/row:bg-surface-2',
      NAME_WIDTH,
      extra,
    );
  const open = openId ? view.lines.find((l) => l.lineId === openId) : undefined;
  const openName = open ? truncateName(open.name, 60) : '';
  const columns = 1 + 12 + 3;

  function lineRow(line: BudgetYearLine) {
    const sectionTotal = view.totals[line.kind].total;
    const group = line.groupId ? groupName.get(line.groupId) : undefined;
    const account = line.accountId ? accountName.get(line.accountId) : undefined;
    const sub = [group, account].filter(Boolean).join(' · ');
    const s = summary(line.kind, line.months, line.total);
    return (
      <tr key={line.lineId} className="group/row">
        <th scope="row" className={nameCell()}>
          <button
            type="button"
            id={`line-${line.lineId}`}
            onClick={() => {
              lastOpened.current = line.lineId;
              setOpenId(line.lineId);
            }}
            className="grid h-[52px] w-full grid-cols-1 content-center px-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:px-4"
          >
            <span className="truncate text-sm font-medium" title={line.name}>
              {truncateName(line.name, 40)}
            </span>
            {sub ? (
              <span className="truncate text-label font-normal text-muted-foreground" title={sub}>
                {sub}
              </span>
            ) : null}
          </button>
        </th>
        {line.months.map((m, i) => {
          const over =
            show === 'actual' && i < started && isOverPlan(line.kind, m.planned, m.actual);
          return (
            <td
              key={m.index}
              className={cn(
                BODY,
                'min-w-24',
                months[i]!.key === todayMonth && 'bg-primary-soft/40',
                over && 'bg-negative-soft',
              )}
            >
              {over ? (
                <>
                  <AlertTriangle
                    className="mr-1 inline size-3 align-[-1px] text-negative"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{t('overPlan')} </span>
                </>
              ) : null}
              {monthCell(line.kind, m, i < started)}
            </td>
          );
        })}
        <td className={cn(BODY, 'min-w-24')}>{amount(s.average, line.kind)}</td>
        <td className={cn(BODY, 'min-w-24 text-muted-foreground')}>
          {share(line.kind, line.months, line.total, sectionTotal)}
        </td>
        <td className={cn(BODY, 'min-w-28 bg-surface font-semibold', TOTAL_PIN, TOTAL_SHADOW)}>
          {amount(s.total, line.kind)}
        </td>
      </tr>
    );
  }

  function totalRow(
    key: string,
    label: string,
    kind: RowKind,
    cells: Cell[],
    total: Cell,
    shade: boolean,
  ) {
    const s = summary(kind, cells, total);
    const bg = shade ? 'bg-surface-2' : 'bg-surface';
    return (
      <tr
        className="group/row font-semibold [&>td]:border-t [&>td]:border-t-border-strong"
        key={key}
      >
        <th
          scope="row"
          className={nameCell(
            cn('h-11 border-t border-t-border-strong px-3 text-sm font-semibold lg:px-4', bg),
          )}
        >
          {label}
        </th>
        {cells.map((c, i) => (
          <td key={i} className={cn(BODY, 'h-11 min-w-24 font-semibold', bg)}>
            {monthCell(kind, c, i < started)}
          </td>
        ))}
        <td className={cn(BODY, 'h-11 min-w-24', bg)}>{amount(s.average, kind)}</td>
        <td className={cn(BODY, 'h-11 min-w-24', bg)} />
        <td className={cn(BODY, 'h-11 min-w-28 font-semibold', bg, TOTAL_PIN, TOTAL_SHADOW)}>
          {amount(s.total, kind)}
        </td>
      </tr>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <p id={captionId} className="sr-only">
        {caption}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {leading}
        <fieldset>
          <legend className="sr-only">{t('toggleLabel')}</legend>
          <div className="inline-flex rounded-lg bg-surface-2 p-1">
            {(['planned', 'actual', 'diff'] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  'flex min-h-10 cursor-pointer items-center rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring md:pointer-fine:min-h-8',
                  show === value
                    ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="year-show"
                  value={value}
                  checked={show === value}
                  onChange={() => choose(value)}
                  className="sr-only"
                />
                {t(`toggle.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="ml-auto">{trailing}</div>
      </div>
      {show === 'diff' ? <p className="text-sm text-muted-foreground">{t('diffLegend')}</p> : null}

      <ScrollRegion
        labelledBy={captionId}
        className="before:hidden lg:after:hidden"
        scrollerClassName="min-h-80 max-h-[calc(100dvh-16rem)] overflow-y-auto md:max-h-[calc(100dvh-12rem)]"
      >
        <table ref={table} className={cn(dataTable.table, 'w-max min-w-full')}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                data-first="true"
                className={cn(
                  HEAD,
                  dataTable.stickyFirstHead,
                  'z-30 text-left lg:px-4',
                  NAME_WIDTH,
                )}
              >
                {t('line')}
              </th>
              {months.map((m) => (
                <th
                  key={m.key}
                  scope="col"
                  data-current={m.key === todayMonth ? 'true' : undefined}
                  className={cn(HEAD, 'min-w-24', m.key === todayMonth && 'bg-primary-soft')}
                >
                  <abbr title={m.long} className="no-underline">
                    {m.short}
                  </abbr>
                  {m.key === todayMonth ? (
                    <span className="sr-only"> ({t('currentMonth')})</span>
                  ) : null}
                </th>
              ))}
              <th
                scope="col"
                className={cn(HEAD, 'min-w-24')}
                title={show === 'actual' ? t('averageElapsed') : undefined}
              >
                {t('average')}
              </th>
              <th scope="col" className={cn(HEAD, 'min-w-24')}>
                {show === 'diff' ? t('executed') : t('share')}
              </th>
              <th scope="col" className={cn(HEAD, 'min-w-28 lg:right-0 lg:z-30', TOTAL_SHADOW)}>
                {t('total')}
              </th>
            </tr>
          </thead>
          {sections.map(({ kind, lines }) => (
            <tbody key={kind}>
              <tr>
                <th
                  scope="rowgroup"
                  className={nameCell('bg-surface-2 px-3 py-2 text-sm font-semibold lg:px-4')}
                >
                  {kinds(`${kind}Plural`)}
                </th>
                <td colSpan={columns - 1} className="border-b border-border bg-surface-2" />
              </tr>
              {lines.map(lineRow)}
              {totalRow(
                `total-${kind}`,
                t('sectionTotal', { section: kinds(`${kind}Plural`) }),
                kind,
                view.totals[kind].months,
                view.totals[kind].total,
                true,
              )}
            </tbody>
          ))}
          <tbody>
            {totalRow(
              'unallocated',
              t('unallocated'),
              'balance',
              view.unallocated.months,
              { planned: view.unallocated.planned, actual: view.unallocated.actual },
              false,
            )}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="text-sm text-muted-foreground">{t('footnote')}</p>

      <Sheet
        open={open !== undefined}
        onOpenChange={(next) => (next ? undefined : setOpenId(null))}
        title={openName}
        description={t('sheetDescription', { name: budget.name })}
        tall
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (lastOpened.current) document.getElementById(`line-${lastOpened.current}`)?.focus();
        }}
        footer={
          canWrite && open ? (
            <div className="flex justify-end">
              <Link
                href={`/budget/lines/${open.lineId}?${new URLSearchParams({ back: `${backBase}&show=${show}#line-${open.lineId}` }).toString()}`}
                className={buttonVariants({})}
              >
                {t('edit')}
              </Link>
            </div>
          ) : undefined
        }
      >
        {open ? (
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{t('sheetCaption', { name: openName })}</caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">
                  {t('month')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('toggle.planned')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('toggle.actual')}
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  {t('toggle.diff')}
                </th>
              </tr>
            </thead>
            <tbody>
              {open.months.map((m, i) => (
                <tr
                  key={m.index}
                  className={cn('border-t', months[i]!.key === todayMonth && 'bg-primary-soft/40')}
                >
                  <th scope="row" className="py-2.5 text-left font-normal">
                    {months[i]!.long}
                  </th>
                  <td className="py-2.5 text-right">{money(m.planned)}</td>
                  <td className="py-2.5 text-right">{i < started ? money(m.actual) : '—'}</td>
                  <td className="py-2.5 text-right">
                    {i < started && !(m.planned === 0 && m.actual === 0)
                      ? signed(difference(open.kind, m))
                      : '—'}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 font-semibold">
                <th scope="row" className="py-2.5 text-left">
                  {t('total')}
                </th>
                <td className="py-2.5 text-right">{money(open.total.planned)}</td>
                <td className="py-2.5 text-right">{money(open.total.actual)}</td>
                <td className="py-2.5 text-right" />
              </tr>
            </tbody>
          </table>
        ) : null}
      </Sheet>
    </div>
  );
}
