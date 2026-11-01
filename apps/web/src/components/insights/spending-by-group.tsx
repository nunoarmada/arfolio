'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { barShare, txHref } from '@/lib/insights-chart';
import { formatBps, type PeriodWords } from '@/lib/insights-format';
import type { InsightsSpending } from '@/server/insights-data';
import { CategoryIcon } from '../category-icon';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { ROW_HEAD, SectionCard, TableRegion, TH, TH_FIRST } from './section-card';
import { useFormatMoney } from '@/components/privacy';

type Ready = Extract<InsightsSpending, { kind: 'ready' }>;

/** The category filter of the list caps at this many ids (see transaction-filters). */
const MAX_IDS = 20;

const colorOf = (slot: number): string => `var(--chart-${((slot - 1) % 7) + 1})`;
const UNCATEGORISED_COLOR = 'var(--chart-8)';

/** The bar: as long as its amount against the largest, with no track, so it reads as a size. */
function Bar({ share, color, height }: { share: number; color: string; height: 'h-2' | 'h-1' }) {
  return (
    <span aria-hidden="true" className={cn('block min-w-0 flex-1', height)}>
      <span
        className="block h-full rounded-full"
        style={{
          width: `${share * 100}%`,
          minWidth: share > 0 ? 2 : 0,
          backgroundColor: color,
        }}
      />
    </span>
  );
}

/**
 * "Despesas por grupo": the groups as a ranking of bars (longest = biggest group), each opening
 * into its categories, which link to the transactions behind them. HTML rows, not an SVG, so the
 * expand buttons and links are native. The same figures are available as a table.
 */
export function SpendingByGroup({
  data,
  from,
  to,
  words,
  title,
}: {
  data: Ready;
  from: string;
  to: string;
  /** The period in words: "outubro", or "agosto" and "outubro" for a longer one. */
  words: PeriodWords;
  title: string;
}) {
  const t = useTranslations('insights');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const baseId = useId();

  const money = (minor: number) => formatMoney(minor, currency, locale);

  const largest = Math.max(data.uncategorised, ...data.groups.map((g) => g.amount), 0);
  const groupBps = data.groups.reduce((a, g) => a + g.shareBps, 0);
  const uncategorisedBps = data.total > 0 ? Math.max(0, 10_000 - groupBps) : 0;

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const caption =
    'single' in words
      ? t('spending.caption', { period: words.single })
      : t('spending.captionRange', words);

  return (
    <SectionCard testId="insights-spending" title={title} toggle={data.total > 0}>
      {(view) => (
        <>
          {data.foreignCount > 0 ? (
            <Alert tone="info" className="bg-surface-2">
              {t('foreign', { count: data.foreignCount })}
            </Alert>
          ) : null}

          {data.total === 0 ? (
            <div className="grid grid-cols-1 justify-items-start gap-1">
              <p className="text-base text-muted-foreground">
                {'single' in words
                  ? t('spending.empty', { period: words.single })
                  : t('spending.emptyRange', words)}
              </p>
              <Link
                href={txHref({ from, to })}
                className="inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
              >
                {t('spending.viewAll')}
              </Link>
            </div>
          ) : (
            <>
              <p className="grid grid-cols-1 gap-0.5">
                <MoneyAmount minor={data.total} currency={currency} kind="neutral" size="lg" />
                <span className="text-sm text-muted-foreground">
                  {'single' in words
                    ? t('spending.totalIn', { period: words.single })
                    : t('spending.totalFrom', words)}
                </span>
              </p>

              {view === 'table' ? (
                <TableRegion label={caption} testId="insights-spending-table" narrow>
                  <thead className="bg-surface-2">
                    <tr>
                      <th scope="col" className={TH_FIRST}>
                        {t('spending.col.name')}
                      </th>
                      <th scope="col" className={cn(TH, 'text-right')}>
                        {t('spending.col.amount')}
                      </th>
                      <th scope="col" className={cn(TH, 'text-right')}>
                        {t('spending.col.share')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.groups.map((g) => (
                      <Fragment key={g.groupId}>
                        <tr className="bg-surface">
                          <th scope="row" className={cn(ROW_HEAD, 'font-semibold')}>
                            {g.name}
                          </th>
                          <td className="px-3 py-2 text-right font-semibold">{money(g.amount)}</td>
                          <td className="px-3 py-2 text-right">{formatBps(g.shareBps, locale)}</td>
                        </tr>
                        {g.categories.map((c) => (
                          <tr key={c.categoryId ?? c.name} className="bg-surface">
                            <th scope="row" className={cn(ROW_HEAD, 'pl-7')}>
                              {c.name}
                            </th>
                            <td className="px-3 py-2 text-right">{money(c.amount)}</td>
                            <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                    {data.uncategorised > 0 ? (
                      <tr className="bg-surface">
                        <th scope="row" className={cn(ROW_HEAD, 'font-semibold')}>
                          {t('spending.uncategorised')}
                        </th>
                        <td className="px-3 py-2 text-right font-semibold">
                          {money(data.uncategorised)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatBps(uncategorisedBps, locale)}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border-strong bg-surface-2">
                      <th scope="row" className={cn(ROW_HEAD, 'bg-surface-2 font-semibold')}>
                        {t('spending.col.total')}
                      </th>
                      <td className="px-3 py-2 text-right font-semibold">{money(data.total)}</td>
                      <td className="px-3 py-2 text-right" />
                    </tr>
                  </tfoot>
                </TableRegion>
              ) : (
                <ul className="grid grid-cols-1 gap-1">
                  {data.groups.map((g) => {
                    const expanded = open.has(g.groupId);
                    const panelId = `${baseId}-${g.groupId}`;
                    const color = colorOf(g.slot);
                    const ids = g.categories
                      .map((c) => c.categoryId)
                      .filter((id): id is string => id !== null);
                    const topCategory = Math.max(...g.categories.map((c) => c.amount), 0);
                    return (
                      <li key={g.groupId} data-testid="spending-group" data-group-id={g.groupId}>
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onClick={() => toggle(g.groupId)}
                          className="flex min-h-14 w-full flex-col justify-center gap-1.5 rounded-md py-2 pr-1 text-left hover:bg-surface-2"
                        >
                          <span className="flex items-center gap-2">
                            <ChevronRight
                              aria-hidden="true"
                              className={cn(
                                'size-5 shrink-0 text-muted-foreground transition-transform duration-[180ms] ease-out',
                                expanded && 'rotate-90',
                              )}
                            />
                            <span className="line-clamp-2 min-w-0 flex-1 break-words text-base font-medium">
                              {g.name}
                            </span>
                            <MoneyAmount minor={g.amount} currency={currency} kind="neutral" />
                          </span>
                          <span className="flex items-center gap-3 pl-7">
                            <Bar share={barShare(g.amount, largest)} color={color} height="h-2" />
                            <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                              {formatBps(g.shareBps, locale)}
                            </span>
                          </span>
                        </button>
                        <div
                          id={panelId}
                          className={cn(
                            'grid grid-cols-1 transition-[grid-template-rows,visibility] duration-[180ms] ease-out',
                            expanded ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]',
                          )}
                        >
                          <div className="min-h-0 overflow-hidden" inert={!expanded}>
                            <ul className="grid grid-cols-1 pb-1">
                              {g.categories.map((c) => {
                                const row = (
                                  <>
                                    <CategoryIcon category={c.category} size={28} />
                                    <span className="grid grid-cols-1 min-w-0 flex-1 gap-1.5">
                                      <span className="line-clamp-2 break-words text-base">
                                        {c.name}
                                      </span>
                                      <span className="flex">
                                        <Bar
                                          share={barShare(c.amount, topCategory)}
                                          color={color}
                                          height="h-1"
                                        />
                                      </span>
                                    </span>
                                    <MoneyAmount
                                      minor={c.amount}
                                      currency={currency}
                                      kind="neutral"
                                    />
                                  </>
                                );
                                return (
                                  <li key={c.categoryId ?? c.name}>
                                    {c.categoryId ? (
                                      <Link
                                        href={txHref({ from, to, categoryIds: [c.categoryId] })}
                                        aria-label={t('spending.categoryLink', {
                                          category: c.name,
                                          amount: money(c.amount),
                                        })}
                                        className="flex min-h-12 items-center gap-3 rounded-md py-1 pl-4 pr-1 hover:bg-surface-2"
                                      >
                                        {row}
                                        <ChevronRight
                                          aria-hidden="true"
                                          className="size-5 shrink-0 text-muted-foreground"
                                        />
                                      </Link>
                                    ) : (
                                      <div className="flex min-h-12 items-center gap-3 py-1 pl-4 pr-1">
                                        {row}
                                        <span aria-hidden="true" className="size-5 shrink-0" />
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            {ids.length > 0 && ids.length <= MAX_IDS ? (
                              <Link
                                href={txHref({ from, to, categoryIds: ids })}
                                className="ml-4 inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
                              >
                                {t('spending.viewGroup', { group: g.name })}
                              </Link>
                            ) : null}
                            <p className="py-1 pl-4 text-sm text-muted-foreground">
                              {t('spending.refundsNote')}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {data.uncategorised > 0 ? (
                    <li data-testid="spending-group" data-group-id="uncategorised">
                      <Link
                        href={txHref({ from, to, uncategorised: true, direction: 'out' })}
                        aria-label={t('spending.categoryLink', {
                          category: t('spending.uncategorised'),
                          amount: money(data.uncategorised),
                        })}
                        className="flex min-h-14 w-full flex-col justify-center gap-1.5 rounded-md py-2 pr-1 hover:bg-surface-2"
                      >
                        <span className="flex items-center gap-2">
                          <span aria-hidden="true" className="size-5 shrink-0" />
                          <span className="line-clamp-2 min-w-0 flex-1 break-words text-base font-medium">
                            {t('spending.uncategorised')}
                          </span>
                          <MoneyAmount
                            minor={data.uncategorised}
                            currency={currency}
                            kind="neutral"
                          />
                        </span>
                        <span className="flex items-center gap-3 pl-7">
                          <Bar
                            share={barShare(data.uncategorised, largest)}
                            color={UNCATEGORISED_COLOR}
                            height="h-2"
                          />
                          <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                            {formatBps(uncategorisedBps, locale)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ) : null}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}
