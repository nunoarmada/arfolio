'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatDayYear } from '@/lib/net-worth-format';
import type { ExitedItem } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { KindIcon } from './kind-icon';

/**
 * "Já não detidos": assets sold or written off and liabilities settled. Collapsed by default and
 * outside every total; the rows keep the anatomy of the lists above and link to the record.
 */
export function ExitedList({ items }: { items: ExitedItem[] }) {
  const t = useTranslations('netWorth');
  const ex = useTranslations('netWorth.exited');
  if (items.length === 0) return null;
  const assets = items.filter((i) => i.side === 'asset');
  const liabilities = items.filter((i) => i.side === 'liability');
  return (
    <details className="group rounded-lg bg-surface shadow-card" data-testid="nw-exited">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-5 [&::-webkit-details-marker]:hidden">
        <h2 className="flex items-baseline gap-2 text-card-title">
          {ex('title')}
          <span className="text-label font-normal tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </h2>
        <ChevronDown
          className="size-5 shrink-0 text-muted-foreground transition-transform duration-[180ms] ease-out group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-cols-1 gap-4 border-t border-border px-4 pb-4 pt-3 md:px-5 md:pb-5 lg:grid-cols-2 xl:gap-6">
        <ExitedSide
          title={t('assets')}
          label={ex('assetsList')}
          items={assets}
          noneLabel={ex('none')}
        />
        <ExitedSide
          title={t('liabilities')}
          label={ex('liabilitiesList')}
          items={liabilities}
          noneLabel={ex('none')}
        />
      </div>
    </details>
  );
}

function ExitedSide({
  title,
  label,
  items,
  noneLabel,
}: {
  title: string;
  label: string;
  items: ExitedItem[];
  noneLabel: string;
}) {
  return (
    <section className="grid min-w-0 grid-cols-1 content-start gap-2">
      <h3 className="text-label text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="text-base text-muted-foreground">{noneLabel}</p>
      ) : (
        <ul
          aria-label={label}
          className="divide-y divide-border overflow-hidden rounded-md bg-surface-2"
        >
          {items.map((item) => (
            <ExitedRow key={`${item.side}:${item.refId}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExitedRow({ item }: { item: ExitedItem }) {
  const t = useTranslations('netWorth');
  const kinds = useTranslations('netWorth.kind');
  const { locale } = useHouseholdFormat();
  const date = formatDayYear(item.date, locale);
  const status =
    item.side === 'liability'
      ? t('exited.settled', { date })
      : item.disposalKind === 'written_off'
        ? t('exited.writtenOff', { date })
        : t('exited.sold', { date });
  return (
    <li data-testid={`nw-exited-${item.refId}`}>
      <Link
        href={
          item.side === 'asset'
            ? `/net-worth/assets/${item.refId}`
            : `/net-worth/liabilities/${item.refId}`
        }
        className="flex min-h-16 items-center gap-3 px-4 py-2 outline-none transition-colors duration-[120ms] hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <KindIcon side={item.side} kind={item.kind} className="max-sm:hidden" />
        <span className="grid min-w-0 flex-1 grid-cols-1">
          <span
            className="line-clamp-2 break-words text-base font-medium sm:line-clamp-1"
            title={item.name}
          >
            {item.name}
          </span>
          <span className="line-clamp-2 text-sm text-muted-foreground">
            {status} · {kinds(item.kind)}
          </span>
        </span>
        {item.saleAmount != null ? (
          <MoneyAmount
            minor={item.saleAmount}
            currency={item.currency}
            kind="neutral"
            className="shrink-0 text-muted-foreground max-sm:text-sm"
          />
        ) : null}
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground sm:size-5"
          aria-hidden="true"
        />
      </Link>
    </li>
  );
}
