'use client';

import { CalendarClock, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BudgetLineView } from '@arfolio/services';
import { monthParam, type MonthState } from '@/lib/budget-period';
import { unbudgetedTotal } from '@/lib/budget-status';
import { formatMonth } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { BudgetDto, LineInfoDto, MonthPageData } from '@/server/budget-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { buttonVariants } from '../ui/button';
import { Card, IconTile } from '../ui/card';
import { SectionHeader } from '../ui/section-header';
import { AllocationCard } from './allocation-card';
import { BudgetLineRow, LineColumnHeader, WIDE_COLUMNS } from './line-row';
import { LineSheet } from './line-sheet';
import { MonthSummary } from './summary-card';
import { UnbudgetedCard } from './unbudgeted-card';
import { useFormatMoney } from '@/components/privacy';

const KINDS = ['income', 'expense', 'saving'] as const;
type Kind = (typeof KINDS)[number];
const NO_GROUP = 'none';
const STORAGE = 'budget-collapsed-groups';

const readCollapsed = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const writeCollapsed = (keys: Set<string>) => {
  try {
    sessionStorage.setItem(STORAGE, JSON.stringify([...keys]));
  } catch {
    // Remembering which groups are folded is a convenience only.
  }
};

export interface EndHint {
  endMonth: string;
  nextStart: string;
}

/** The month at a glance: summary, what is left to allocate, every line, and unbudgeted spending. */
export function MonthView({
  budget,
  month,
  state,
  data,
  pinned,
  canWrite,
  endHint,
}: {
  budget: BudgetDto;
  month: string;
  state: MonthState;
  data: MonthPageData;
  pinned: boolean;
  canWrite: boolean;
  endHint: EndHint | null;
}) {
  const t = useTranslations('budget');
  const kinds = useTranslations('budget.kinds');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const { view, lines, unbudgeted, plan, lookups, pace } = data;
  const money = (minor: number) => formatMoney(minor, currency, locale);

  const info = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const categories = useMemo(() => new Map(lookups.categories.map((c) => [c.id, c])), [lookups]);
  const groupOrder = useMemo(
    () => new Map(lookups.groups.map((g, i) => [g.id, { name: g.name, order: i }])),
    [lookups],
  );
  const accounts = useMemo(() => new Map(lookups.accounts.map((a) => [a.id, a])), [lookups]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showEmpty, setShowEmpty] = useState<Record<Kind, boolean>>({
    income: false,
    expense: false,
    saving: false,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const lastOpened = useRef<string | null>(null);

  useEffect(() => setCollapsed(readCollapsed()), []);

  // A deep link (#line-<id>, from a notification or after saving a line) scrolls to its row.
  useEffect(() => {
    const id = window.location.hash.match(/^#line-([0-9a-f-]{36})$/i)?.[1];
    if (!id) return;
    const target = info.get(id);
    if (!target) return;
    const key = `${target.kind}:${target.groupId ?? NO_GROUP}`;
    setCollapsed((cur) => {
      if (!cur.has(key)) return cur;
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
    setShowEmpty((cur) => ({ ...cur, [target.kind]: true }));
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`line-${id}`);
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [info]);

  function toggleGroup(key: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(next);
      return next;
    });
  }

  const range = { from: view.from, to: view.to };
  const monthKey = monthParam(month);
  const backFor = (lineId: string) =>
    `/budget?${new URLSearchParams({ month: monthKey, ...(pinned ? { budget: budget.id } : {}) }).toString()}#line-${lineId}`;
  const editHref = (lineId: string) =>
    `/budget/lines/${lineId}?${new URLSearchParams({ back: backFor(lineId) }).toString()}`;

  const foreign =
    view.lines.some((l) => l.foreignCurrencyRows > 0) ||
    unbudgeted.some((r) => r.foreignCurrencyRows > 0);
  const noLinks =
    lines.length > 0 &&
    lines.every((l) => l.categoryIds.length === 0 && !(l.kind === 'saving' && l.accountId));

  // The aside holds the transfer plan and, when there is booked spending no line covers, a second card.
  const wideAside = unbudgeted.length === 0;

  const open = openId ? (view.lines.find((l) => l.lineId === openId) ?? null) : null;
  const openInfo = openId ? (info.get(openId) ?? null) : null;

  function sectionBody(kind: Kind) {
    const sectionLines = view.lines.filter((l) => l.kind === kind);
    const isEmpty = (l: BudgetLineView) => l.planned === 0 && l.actual === 0 && l.pending === 0;
    const shown = sectionLines.filter((l) => !isEmpty(l));
    const hidden = sectionLines.filter(isEmpty);
    // Groups in the order of the household's categories; lines without a group last.
    const groupIds = [...new Set(shown.map((l) => l.groupId))].sort((a, b) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (groupOrder.get(a)?.order ?? 999) - (groupOrder.get(b)?.order ?? 999);
    });
    const plainOnly = groupIds.length === 1 && groupIds[0] === null;
    const renderRow = (l: BudgetLineView) => (
      <li key={l.lineId}>
        <BudgetLineRow
          line={l}
          state={state}
          pace={pace}
          onOpen={() => {
            lastOpened.current = l.lineId;
            setOpenId(l.lineId);
            setSheetOpen(true);
          }}
        />
      </li>
    );
    return (
      <>
        {groupIds.map((groupId) => {
          const key = `${kind}:${groupId ?? NO_GROUP}`;
          const inGroup = shown.filter((l) => l.groupId === groupId);
          const totals = view.groups.find((g) => g.kind === kind && g.groupId === groupId);
          const isCollapsed = collapsed.has(key);
          const name = groupId ? (groupOrder.get(groupId)?.name ?? t('noGroup')) : t('noGroup');
          const panelId = `panel-${key.replace(/[^a-z0-9-]/gi, '-')}`;
          return (
            <div key={key}>
              {plainOnly ? null : (
                <h3 className="m-0">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={panelId}
                    onClick={() => toggleGroup(key)}
                    className="flex min-h-12 w-full items-center gap-2 border-b bg-surface-2/60 px-4 text-left text-sm font-medium text-muted-foreground hover:bg-surface-2"
                  >
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 transition-transform duration-[180ms]',
                        isCollapsed && '-rotate-90',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="shrink-0 tabular-nums">
                      {t('ofPlanned', {
                        actual: money(totals?.actual ?? 0),
                        planned: money(totals?.planned ?? 0),
                      })}
                    </span>
                  </button>
                </h3>
              )}
              <div
                id={panelId}
                inert={isCollapsed}
                className={cn(
                  'grid grid-cols-1 transition-[grid-template-rows,visibility] duration-[180ms] ease-out',
                  isCollapsed ? 'invisible grid-rows-[0fr]' : 'visible grid-rows-[1fr]',
                )}
              >
                <ul className="min-h-0 divide-y overflow-hidden">{inGroup.map(renderRow)}</ul>
              </div>
            </div>
          );
        })}
        {hidden.length > 0 ? (
          <div className="border-t first:border-t-0">
            <button
              type="button"
              aria-expanded={showEmpty[kind]}
              onClick={() => setShowEmpty((cur) => ({ ...cur, [kind]: !cur[kind] }))}
              className="flex min-h-12 w-full items-center gap-2 px-4 text-left text-sm text-primary hover:bg-surface-2"
            >
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 transition-transform duration-[180ms]',
                  !showEmpty[kind] && '-rotate-90',
                )}
                aria-hidden="true"
              />
              {showEmpty[kind]
                ? t('hideEmpty', { count: hidden.length })
                : t('showEmpty', { count: hidden.length })}
            </button>
            {showEmpty[kind] ? (
              <ul className="divide-y border-t">{hidden.map(renderRow)}</ul>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  /** Money that moved into a shared account no line explains: shown, never added to the total. */
  function unassignedRows() {
    if (view.unassignedSavings.length === 0) return null;
    return (
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {view.unassignedSavings.map((u) => (
            <li
              key={u.accountId}
              aria-describedby="unassigned-note"
              className={cn(
                'grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-muted-foreground',
                WIDE_COLUMNS,
              )}
            >
              <span className="min-w-0 break-words text-base @[600px]:col-start-1">
                {t('unassigned.label', { account: u.accountName })}
              </span>
              <span className="text-right tabular-nums @[600px]:col-start-3">
                {u.actual > 0 ? '+' : ''}
                {money(u.actual)}
              </span>
            </li>
          ))}
        </ul>
        <p
          id="unassigned-note"
          className="border-t border-border px-4 py-2 text-sm text-muted-foreground"
        >
          {t('unassigned.note')}
        </p>
      </div>
    );
  }

  const currentOpenAccount = openInfo?.accountId ? accounts.get(openInfo.accountId) : undefined;
  const openGroupName = openInfo?.groupId ? (groupOrder.get(openInfo.groupId)?.name ?? null) : null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12 xl:items-start xl:gap-6">
      {foreign ? (
        <Alert tone="info" className="xl:col-span-12">
          {t('foreignNotice')}
        </Alert>
      ) : null}
      {noLinks ? (
        <Alert tone="info" className="xl:col-span-12">
          {t('noLinks')}
        </Alert>
      ) : null}

      <div className="xl:col-span-12">
        <MonthSummary
          view={view}
          state={state}
          pace={pace}
          unbudgeted={unbudgetedTotal(unbudgeted)}
        />
      </div>

      <div
        className={cn(
          'contents',
          // Two cards earn a side column; one card is a full-width strip, as below xl.
          !wideAside &&
            'xl:sticky xl:top-6 xl:order-2 xl:col-span-4 xl:-m-1 xl:grid xl:max-h-[calc(100dvh-3rem)] xl:grid-cols-1 xl:content-start xl:gap-6 xl:overflow-y-auto xl:p-1',
        )}
      >
        <div className={cn('order-1', wideAside ? 'xl:col-span-12' : 'xl:order-none')}>
          <AllocationCard
            unallocated={view.unallocated}
            plan={plan}
            month={month}
            {...(pinned ? { budgetId: budget.id } : {})}
          />
        </div>
        <div className="order-3 xl:order-none">
          <UnbudgetedCard
            rows={unbudgeted}
            categories={categories}
            expenseLines={lines.filter((l: LineInfoDto) => l.kind === 'expense')}
            range={range}
            canWrite={canWrite}
          />
        </div>
      </div>

      <div
        className={cn(
          'order-2 grid grid-cols-1 gap-6 @container',
          wideAside ? 'xl:col-span-12' : 'xl:order-1 xl:col-span-8',
        )}
      >
        {KINDS.map((kind) => {
          const total = view.totals[kind];
          const count = view.lines.filter((l) => l.kind === kind).length;
          return (
            <section
              key={kind}
              aria-labelledby={`section-${kind}`}
              className="grid grid-cols-1 gap-2"
            >
              <SectionHeader
                id={`section-${kind}`}
                title={kinds(`${kind}Plural`)}
                count={count}
                aggregate={t('ofPlanned', {
                  actual: money(total.actual),
                  planned: money(total.planned),
                })}
              />
              {total.pending !== 0 ? (
                <p className="-mt-1 text-sm text-muted-foreground">
                  {t('sectionPending', { amount: money(Math.abs(total.pending)) })}
                </p>
              ) : null}
              {count > 0 || (kind === 'saving' && view.unassignedSavings.length > 0) ? (
                <Card pad="none" className="overflow-hidden">
                  {count > 0 ? <LineColumnHeader /> : null}
                  {sectionBody(kind)}
                  {kind === 'saving' ? unassignedRows() : null}
                </Card>
              ) : (
                <Card pad="sm" className="text-sm text-muted-foreground">
                  {t('emptySection')}
                </Card>
              )}
            </section>
          );
        })}

        {endHint ? (
          <Card pad="sm" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <IconTile icon={CalendarClock} tone="neutral" />
            <p className="min-w-0 flex-1 basis-48 text-base">
              {t('endsIn', {
                name: budget.name,
                month: formatMonth(endHint.endMonth, locale),
              })}
            </p>
            <Link
              href={`/budget/new?start=${monthParam(endHint.nextStart)}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('createNext')}
            </Link>
          </Card>
        ) : null}
      </div>

      <LineSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        line={open}
        info={openInfo}
        state={state}
        pace={pace}
        range={range}
        groupName={openGroupName}
        accountName={currentOpenAccount?.name ?? null}
        categories={categories}
        editHref={canWrite && openId ? editHref(openId) : null}
        onCloseAutoFocus={(e) => {
          // No Dialog.Trigger exists, so return focus to the row that opened the sheet.
          e.preventDefault();
          if (lastOpened.current) document.getElementById(`line-${lastOpened.current}`)?.focus();
        }}
      />
    </div>
  );
}
