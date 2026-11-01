'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { formatMonthTitle, formatMonthYear } from '@/lib/net-worth-format';
import type { InstalmentRow } from '@/lib/net-worth-schedule';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { useFormatMoney } from '@/components/privacy';

type Row = InstalmentRow & { thisMonth: boolean };

/**
 * Instalments as a table: Mês, Prestação, Juros, Capital, Em dívida on wide screens; on phones
 * Mês, Prestação (with the interest and principal split under it) and Em dívida. `scroll` puts
 * the table in its own focusable region with a sticky header (the full plan).
 */
export function ScheduleTable({
  rows,
  currency,
  scroll = false,
}: {
  rows: Row[];
  currency: string;
  scroll?: boolean;
}) {
  const t = useTranslations('schedule');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const table = useRef<HTMLTableElement>(null);

  // The full plan opens at this month's row, not at instalment 1.
  useEffect(() => {
    const region = table.current?.closest<HTMLElement>('[role="region"]');
    if (!scroll || !region) return;
    const current = region.querySelector<HTMLElement>('[aria-current="date"]');
    const head = region.querySelector<HTMLElement>('thead');
    if (current) region.scrollTop = current.offsetTop - (head?.offsetHeight ?? 0);
  }, [scroll, rows]);

  const th = cn(dataTable.th, 'text-right');
  const cell = cn(dataTable.td, 'h-auto py-2 text-right');
  return (
    <ScrollRegion
      label={scroll ? t('fullRegion') : t('tableCaption')}
      className="@container"
      scrollerClassName={scroll ? 'max-h-[60vh] overflow-y-auto' : undefined}
    >
      <table ref={table} className={cn(dataTable.table, 'min-w-[17rem] tabular-nums')}>
        <caption className="sr-only">{scroll ? t('fullRegion') : t('tableCaption')}</caption>
        <thead className={cn(scroll && 'sticky top-0 z-10')}>
          <tr>
            <th scope="col" className={cn(th, 'text-left', dataTable.stickyFirstHead)}>
              {t('col.month')}
            </th>
            <th scope="col" className={th}>
              {t('col.payment')}
            </th>
            <th scope="col" className={cn(th, 'hidden @2xl:table-cell')}>
              {t('col.interest')}
            </th>
            <th scope="col" className={cn(th, 'hidden @2xl:table-cell')}>
              {t('col.capital')}
            </th>
            <th scope="col" className={th}>
              {t('col.balance')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.n}
              aria-current={row.thisMonth ? 'date' : undefined}
              className={cn(dataTable.row, row.thisMonth && 'bg-primary-soft')}
            >
              <th
                scope="row"
                className={cn(
                  cell,
                  'whitespace-nowrap text-left font-normal',
                  dataTable.stickyFirst,
                  row.thisMonth && 'bg-primary-soft',
                )}
              >
                <span className="@2xl:hidden">{formatMonthYear(row.date, locale)}</span>
                <span className="hidden @2xl:inline">{formatMonthTitle(row.date, locale)}</span>
                {row.thisMonth ? (
                  <span className="mt-0.5 block w-fit rounded-full bg-surface px-2 py-0.5 text-caption font-medium">
                    {t('thisMonth')}
                  </span>
                ) : null}
              </th>
              <td className={cell}>
                <MoneyAmount minor={row.payment} currency={currency} size="sm" />
                <span className="block text-xs text-muted-foreground @2xl:hidden">
                  {t('splitInterest', { interest: formatMoney(row.interest, currency, locale) })}
                </span>
                <span className="block text-xs text-muted-foreground @2xl:hidden">
                  {t('splitCapital', { capital: formatMoney(row.principalPaid, currency, locale) })}
                </span>
              </td>
              <td className={cn(cell, 'hidden @2xl:table-cell')}>
                <MoneyAmount minor={row.interest} currency={currency} size="sm" />
              </td>
              <td className={cn(cell, 'hidden @2xl:table-cell')}>
                <MoneyAmount minor={row.principalPaid} currency={currency} size="sm" />
              </td>
              <td className={cell}>
                <MoneyAmount minor={row.balance} currency={currency} size="sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
