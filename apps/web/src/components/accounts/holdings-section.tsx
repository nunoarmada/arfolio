'use client';

import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Holding, Holdings } from '@arfolio/services';
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
  holding: Holding;
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

function HoldingsTable({
  items,
  holdings,
  caption,
}: {
  items: Holding[];
  holdings: Holdings;
  caption: string;
}) {
  const t = useTranslations('accounts.holdings');
  const { locale } = useHouseholdFormat();
  const formatQuantity = formatQuantityFor(usePrivacy().hidden);
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
        <tbody>
          {items.map((h, i) => (
            <tr key={keyOf(h, i)} tabIndex={-1} className={cn(dataTable.row, 'scroll-mt-16')}>
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
                {h.weightBps === null ? (
                  <span className="block text-right text-muted-foreground">
                    <span aria-hidden="true">—</span>
                  </span>
                ) : (
                  <span className="grid grid-cols-1 justify-items-end gap-1 tabular-nums">
                    {formatBps(h.weightBps, locale)}
                    <WeightBar bps={h.weightBps} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
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
    const items = expanded ? holdings.items : holdings.items.slice(0, FIRST);
    const asOf = holdings.asOf
      ? t('asOf', { date: formatAsOf(holdings.asOf, today, locale) })
      : null;
    return (
      <>
        <MobileList items={items} />
        <HoldingsTable
          items={items}
          holdings={holdings}
          caption={[t('title'), asOf].filter(Boolean).join(', ')}
        />
        {holdings.items.some((h) => h.currency !== holdings.currency) ? (
          <p className="text-sm text-muted-foreground">{t('excludesOther')}</p>
        ) : null}
        {holdings.items.length > FIRST && !expanded ? (
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
