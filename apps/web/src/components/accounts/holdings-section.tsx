'use client';

import { AlertTriangle, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Holding, HoldingGroup, Holdings } from '@arfolio/services';
import { cn } from '@/lib/cn';
import {
  decimalToMinor,
  formatAsOf,
  formatBps,
  formatQuantityFor,
  gainSign,
  isStale,
  signedAmount,
} from '@/lib/holdings-format';
import { EmptyState } from '../empty-state';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { SectionHeader } from '../ui/section-header';
import { useFormatMoney, usePrivacy } from '@/components/privacy';

const FIRST = 10;

const GAIN_TONE = { gain: 'text-positive', loss: 'text-negative', flat: 'text-muted-foreground' };

/** Gain or loss: sign, icon and (screen reader) word say it, colour only repeats it. */
function Gain({
  holding,
  stacked = false,
  className,
}: {
  holding: Pick<Holding, 'currency' | 'cost' | 'profit' | 'profitBps'>;
  stacked?: boolean;
  className?: string;
}) {
  const t = useTranslations('accounts.holdings');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  if (holding.cost === null || holding.profit === null) {
    return (
      <span className={cn('whitespace-nowrap text-muted-foreground', className)}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('noCost')}</span>
      </span>
    );
  }
  const minor = decimalToMinor(holding.profit, holding.currency);
  const sign = gainSign(minor);
  const Icon = sign === 'gain' ? TrendingUp : sign === 'loss' ? TrendingDown : null;
  const amount = signedAmount(minor, formatMoney(Math.abs(minor), holding.currency, locale));
  const percent = holding.profitBps === null ? null : formatBps(holding.profitBps, locale, true);
  return (
    <span
      className={cn(
        'whitespace-nowrap tabular-nums',
        stacked ? 'grid grid-cols-1 justify-items-end' : 'inline-flex items-center gap-1',
        GAIN_TONE[sign],
        className,
      )}
    >
      {sign === 'flat' ? null : (
        <span className="sr-only">{t(sign === 'gain' ? 'gain' : 'loss')} </span>
      )}
      <span className="inline-flex items-center gap-1">
        {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        {amount}
      </span>
      {percent ? (
        <span className={stacked ? 'text-sm' : undefined}>
          {stacked ? percent : `(${percent})`}
        </span>
      ) : null}
    </span>
  );
}

function WeightBar({ bps }: { bps: number }) {
  return (
    <span aria-hidden="true" className="block h-1 w-16 overflow-hidden rounded-full bg-surface-3">
      <span
        className="block h-full rounded-full bg-foreground/60"
        style={{ width: `${Math.min(100, Math.max(0, bps / 100))}%` }}
      />
    </span>
  );
}

const keyOf = (h: Holding, i: number) => `${h.ticker}|${h.currency}|${i}`;

/** Weight as a percentage with its bar, or a dash when it is unknown. */
function Weight({ bps }: { bps: number | null }) {
  const { locale } = useHouseholdFormat();
  return bps === null ? (
    <span className="block text-right text-muted-foreground">
      <span aria-hidden="true">—</span>
    </span>
  ) : (
    <span className="grid grid-cols-1 justify-items-end gap-1 tabular-nums">
      {formatBps(bps, locale)}
      <WeightBar bps={bps} />
    </span>
  );
}

function useGroupName() {
  const t = useTranslations('accounts.holdings');
  return (g: HoldingGroup) => g.name ?? t('outsidePies');
}

const groupKey = (g: HoldingGroup) => g.id ?? 'outside';

/** Which pies are expanded (all start collapsed) and how to toggle one. */
type GroupsOpen = { isOpen: (g: HoldingGroup) => boolean; toggle: (g: HoldingGroup) => void };

/** The pie's name as a disclosure button, with how many instruments it holds. */
function GroupToggle({
  group,
  open,
  className,
}: {
  group: HoldingGroup;
  open: GroupsOpen;
  className?: string;
}) {
  const t = useTranslations('accounts.holdings');
  const groupName = useGroupName();
  const expanded = open.isOpen(group);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => open.toggle(group)}
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0 text-muted-foreground transition-transform duration-[120ms] motion-reduce:transition-none',
          expanded && 'rotate-90',
        )}
      />
      <span className="min-w-0 truncate" title={groupName(group)}>
        {groupName(group)}
      </span>
      <span className="shrink-0 text-sm font-normal text-muted-foreground">
        {t('itemCount', { count: group.items.length })}
      </span>
    </button>
  );
}

function MobileRow({ holding }: { holding: Holding }) {
  const t = useTranslations('accounts.holdings');
  const { locale } = useHouseholdFormat();
  const formatQuantity = formatQuantityFor(usePrivacy().hidden);
  const quantity = formatQuantity(holding.quantity, locale);
  const meta =
    holding.weightBps === null
      ? t('metaNoWeight', { ticker: holding.ticker, quantity })
      : t('meta', {
          ticker: holding.ticker,
          quantity,
          weight: formatBps(holding.weightBps, locale),
        });
  return (
    <li
      tabIndex={-1}
      className="grid min-h-14 scroll-mt-16 grid-cols-1 gap-0.5 px-4 py-2 outline-none focus-visible:bg-surface-2"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-base font-medium" title={holding.name}>
          {holding.name}
        </span>
        <MoneyAmount
          minor={decimalToMinor(holding.value, holding.currency)}
          currency={holding.currency}
          kind="balance"
          size="md"
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm text-muted-foreground @max-[330px]:grid-cols-1">
        <span className="truncate" title={meta}>
          {meta}
        </span>
        <Gain holding={holding} className="@max-[330px]:justify-self-end" />
      </div>
    </li>
  );
}

function ItemRow({ holding: h }: { holding: Holding }) {
  const { locale } = useHouseholdFormat();
  const formatQuantity = formatQuantityFor(usePrivacy().hidden);
  return (
    <tr tabIndex={-1} className={cn(dataTable.row, 'scroll-mt-16')}>
      <th
        scope="row"
        className={cn(dataTable.td, dataTable.stickyFirst, 'h-14 text-left font-normal')}
      >
        <span className="block max-w-72 truncate font-medium" title={h.name}>
          {h.name}
        </span>
        <span className="block max-w-72 truncate text-label font-normal text-muted-foreground">
          {[h.ticker, h.isin].filter((v, n, all) => v && all.indexOf(v) === n).join(' · ')}
        </span>
      </th>
      <td className={cn(dataTable.td, dataTable.tdNum, 'whitespace-nowrap')}>
        {formatQuantity(h.quantity, locale)}
      </td>
      <td className={cn(dataTable.td, 'text-right')}>
        <MoneyAmount
          minor={decimalToMinor(h.value, h.currency)}
          currency={h.currency}
          kind="balance"
          size="md"
          className="font-semibold"
        />
      </td>
      <td className={cn(dataTable.td, 'text-right')}>
        <Gain holding={h} stacked />
      </td>
      <td className={dataTable.td}>
        <Weight bps={h.weightBps} />
      </td>
    </tr>
  );
}

function HoldingsTable({
  items,
  groups,
  open,
  holdings,
  caption,
}: {
  items: Holding[];
  groups: HoldingGroup[] | null;
  open: GroupsOpen;
  holdings: Holdings;
  caption: string;
}) {
  const t = useTranslations('accounts.holdings');
  const currency = holdings.currency ?? 'EUR';
  const th = (num = false) => cn(dataTable.th, num && dataTable.thNum);
  return (
    <ScrollRegion label={t('tableLabel')} className="hidden lg:block">
      <table className={dataTable.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(th(), dataTable.stickyFirstHead, 'min-w-56')}>
              {t('colAsset')}
            </th>
            <th scope="col" className={th(true)}>
              {t('colQuantity')}
            </th>
            <th scope="col" className={th(true)}>
              {t('colValue')}
            </th>
            <th scope="col" className={th(true)}>
              {t('colGain')}
            </th>
            <th scope="col" className={th(true)}>
              {t('colWeight')}
            </th>
          </tr>
        </thead>
        {groups ? null : (
          <tbody>
            {items.map((h, i) => (
              <ItemRow key={keyOf(h, i)} holding={h} />
            ))}
          </tbody>
        )}
        {groups?.map((g) => (
          <tbody key={groupKey(g)}>
            <tr className="font-semibold">
              <th
                scope="rowgroup"
                className={cn(dataTable.td, dataTable.stickyFirst, 'h-12 bg-surface-2 text-left')}
              >
                <GroupToggle group={g} open={open} className="max-w-80" />
              </th>
              <td className={cn(dataTable.td, 'bg-surface-2')} />
              <td className={cn(dataTable.td, 'bg-surface-2 text-right')}>
                <MoneyAmount
                  minor={decimalToMinor(g.value, g.currency)}
                  currency={g.currency}
                  kind="balance"
                  size="md"
                  className="font-semibold"
                />
              </td>
              <td className={cn(dataTable.td, 'bg-surface-2 text-right font-normal')}>
                <Gain holding={g} stacked />
              </td>
              <td className={cn(dataTable.td, 'bg-surface-2 font-normal')}>
                <Weight bps={g.weightBps} />
              </td>
            </tr>
            {open.isOpen(g)
              ? g.items.map((h, i) => <ItemRow key={keyOf(h, i)} holding={h} />)
              : null}
          </tbody>
        ))}
        <tfoot>
          <tr className={dataTable.totals}>
            <th
              scope="row"
              className={cn(
                dataTable.td,
                dataTable.stickyFirst,
                'border-t border-t-border-strong text-left',
              )}
            >
              {t('total')}
            </th>
            <td className={dataTable.td} />
            <td className={cn(dataTable.td, 'text-right')}>
              <MoneyAmount
                minor={decimalToMinor(holdings.total, currency)}
                currency={currency}
                kind="balance"
                size="md"
                className="font-semibold"
              />
            </td>
            <td className={dataTable.td} />
            <td className={dataTable.td} />
          </tr>
        </tfoot>
      </table>
    </ScrollRegion>
  );
}

/**
 * "Investimentos" on an account page: the positions of the latest snapshot, largest first.
 * `holdings` is null when they could not be loaded, which fails this section only.
 */
function HoldingsContent({ holdings, today }: { holdings: Holdings | null; today: string }) {
  const t = useTranslations('accounts.holdings');
  const { locale } = useHouseholdFormat();
  const [expanded, setExpanded] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const open: GroupsOpen = {
    isOpen: (g) => openGroups.has(groupKey(g)),
    toggle: (g) =>
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (!next.delete(groupKey(g))) next.add(groupKey(g));
        return next;
      }),
  };
  const root = useRef<HTMLElement>(null);

  // After "Ver todas", focus moves to the first row that was not there before.
  useEffect(() => {
    if (!expanded || !root.current) return;
    const rows = root.current.querySelectorAll<HTMLElement>('li[tabindex], tbody tr[tabindex]');
    const visible = [...rows].filter((el) => el.offsetParent !== null);
    visible[FIRST]?.focus();
  }, [expanded]);

  const body = (() => {
    if (holdings === null) return <HoldingsError />;
    if (holdings.items.length === 0) {
      return <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>;
    }
    const groups = holdings.groups;
    // Grouped by pie, every instrument is shown: cutting a pie in half would misread it.
    const items = expanded || groups ? holdings.items : holdings.items.slice(0, FIRST);
    const asOf = holdings.asOf
      ? t('asOf', { date: formatAsOf(holdings.asOf, today, locale) })
      : null;
    return (
      <>
        {groups ? <MobileGroups groups={groups} open={open} /> : <MobileList items={items} />}
        <HoldingsTable
          items={items}
          groups={groups}
          open={open}
          holdings={holdings}
          caption={[t('title'), asOf].filter(Boolean).join(', ')}
        />
        {holdings.items.some((h) => h.currency !== holdings.currency) ? (
          <p className="text-sm text-muted-foreground">{t('excludesOther')}</p>
        ) : null}
        {!groups && holdings.items.length > FIRST && !expanded ? (
          <Button variant="ghost" className="justify-self-start" onClick={() => setExpanded(true)}>
            {t('showAll', { count: holdings.items.length })}
          </Button>
        ) : null}
      </>
    );
  })();

  const asOf = holdings?.asOf && holdings.items.length > 0 ? holdings.asOf : null;

  return (
    <section
      ref={root}
      aria-labelledby="holdings-title"
      className="grid scroll-mt-16 grid-cols-1 gap-3 md:scroll-mt-0"
    >
      <SectionHeader
        id="holdings-title"
        title={t('title')}
        action={
          holdings && holdings.items.length > 0 ? (
            <MoneyAmount
              minor={decimalToMinor(holdings.total, holdings.currency ?? 'EUR')}
              currency={holdings.currency ?? 'EUR'}
              kind="balance"
              size="md"
              className="font-semibold"
            />
          ) : undefined
        }
      />
      {asOf ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
          <span>{t('asOf', { date: formatAsOf(asOf, today, locale) })}</span>
          {isStale(asOf, today) ? (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
              {t('stale')}
            </span>
          ) : null}
        </p>
      ) : null}
      {body}
    </section>
  );
}

function MobileList({ items }: { items: Holding[] }) {
  return (
    <ul className="@container divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card lg:hidden">
      {items.map((h, i) => (
        <MobileRow key={keyOf(h, i)} holding={h} />
      ))}
    </ul>
  );
}

/** Each pie as a card: name, value, gain and weight; its instruments once expanded. */
function MobileGroups({ groups, open }: { groups: HoldingGroup[]; open: GroupsOpen }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:hidden">
      {groups.map((g) => {
        const id = `holdings-group-${groupKey(g)}`;
        const expanded = open.isOpen(g);
        return (
          <section
            key={groupKey(g)}
            aria-labelledby={id}
            className="@container overflow-hidden rounded-lg bg-surface shadow-card"
          >
            <div
              className={cn(
                'grid grid-cols-1 gap-0.5 bg-surface-2 px-4 py-1',
                expanded && 'border-b border-border',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id={id} className="min-w-0 text-base font-semibold">
                  <GroupToggle group={g} open={open} className="w-full" />
                </h3>
                <MoneyAmount
                  minor={decimalToMinor(g.value, g.currency)}
                  currency={g.currency}
                  kind="balance"
                  size="md"
                  className="font-semibold"
                />
              </div>
              <div className="flex items-center justify-between gap-3 pb-1 text-sm text-muted-foreground">
                <GroupWeight bps={g.weightBps} />
                <Gain holding={g} />
              </div>
            </div>
            {expanded ? (
              <ul className="divide-y divide-border">
                {g.items.map((h, i) => (
                  <MobileRow key={keyOf(h, i)} holding={h} />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function GroupWeight({ bps }: { bps: number | null }) {
  const t = useTranslations('accounts.holdings');
  const { locale } = useHouseholdFormat();
  return <span>{bps === null ? null : t('groupWeight', { weight: formatBps(bps, locale) })}</span>;
}

/** The section's failure: what failed and a retry, in the section's own frame. */
function HoldingsError() {
  const t = useTranslations('accounts.holdings');
  const common = useTranslations('common');
  const router = useRouter();
  return (
    <Alert
      tone="error"
      action={
        <Button variant="outline" onClick={() => router.refresh()}>
          {common('retry')}
        </Button>
      }
    >
      {t('error')}
    </Alert>
  );
}

function HoldingsFailed() {
  const t = useTranslations('accounts.holdings');
  return (
    <section aria-labelledby="holdings-title" className="grid grid-cols-1 gap-3">
      <SectionHeader id="holdings-title" title={t('title')} />
      <HoldingsError />
    </section>
  );
}

/** A render failure in the section (odd data) must not take the account page down with it. */
class HoldingsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <HoldingsFailed /> : this.props.children;
  }
}

export function HoldingsSection(props: { holdings: Holdings | null; today: string }) {
  return (
    <HoldingsBoundary>
      <HoldingsContent {...props} />
    </HoldingsBoundary>
  );
}
