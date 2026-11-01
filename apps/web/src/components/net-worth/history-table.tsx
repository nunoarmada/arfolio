'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { placeRows, shiftMonth, type ChartRow } from '@/lib/net-worth-chart';
import { formatMonthTitle, formatMonthYear } from '@/lib/net-worth-format';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { useFormatMoney } from '@/components/privacy';

/**
 * The chart as a table: newest month first, a missing month is a row that says so (so gaps are
 * explicit) and the live month is tagged. Phones show Mês, Património líquido and Variação, with
 * Ativos and Passivos as a muted second line.
 */
export function HistoryTable({
  rows,
  scale,
  currentMonth,
}: {
  rows: ChartRow[];
  scale: { start: string; count: number };
  currentMonth: string;
}) {
  const t = useTranslations('netWorthChart');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const entries = useMemo(() => {
    const byMonth = new Map(placeRows(rows, scale).map((p) => [p.month, p]));
    const first = placeRows(rows, scale)[0]?.slot ?? 0;
    const out: Array<{ month: string; point: ChartRow | null }> = [];
    for (let slot = scale.count - 1; slot >= first; slot--) {
      const month = shiftMonth(scale.start, slot);
      out.push({ month, point: byMonth.get(month) ?? null });
    }
    return out;
  }, [rows, scale]);

  const head = cn(dataTable.th, '@2xl:px-3');
  const cell = cn(dataTable.td, 'h-auto py-2');
  return (
    <ScrollRegion label={t('caption')} className="@container">
      <table className={cn(dataTable.table, 'tabular-nums')}>
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(head, dataTable.stickyFirstHead)}>
              {t('col.month')}
            </th>
            <th scope="col" className={cn(head, 'hidden text-right @2xl:table-cell')}>
              {t('col.assets')}
            </th>
            <th scope="col" className={cn(head, 'hidden text-right @2xl:table-cell')}>
              {t('col.liabilities')}
            </th>
            <th scope="col" className={cn(head, 'text-right')}>
              {t('col.net')}
            </th>
            <th scope="col" className={cn(head, 'text-right')}>
              {t('col.change')}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(({ month, point }) => (
            <tr key={month} className={dataTable.row}>
              <th
                scope="row"
                className={cn(
                  cell,
                  dataTable.stickyFirst,
                  'whitespace-nowrap text-left font-normal',
                )}
              >
                <span className="block text-base @2xl:hidden">
                  {formatMonthYear(month, locale)}
                </span>
                <span className="hidden text-base @2xl:block">
                  {formatMonthTitle(month, locale)}
                </span>
                {month === currentMonth ? (
                  <span className="text-xs text-muted-foreground">{t('inProgress')}</span>
                ) : null}
              </th>
              {point ? (
                <>
                  <td className={cn(cell, 'hidden text-right @2xl:table-cell')}>
                    <MoneyAmount
                      minor={point.assets}
                      currency={currency}
                      kind="balance"
                      size="sm"
                    />
                  </td>
                  <td className={cn(cell, 'hidden text-right @2xl:table-cell')}>
                    <MoneyAmount
                      minor={point.liabilities}
                      currency={currency}
                      kind="neutral"
                      size="sm"
                    />
                  </td>
                  <td className={cn(cell, 'text-right')}>
                    <MoneyAmount minor={point.net} currency={currency} kind="balance" />
                    <span className="block text-xs text-muted-foreground @2xl:hidden">
                      {t('col.assets')} {formatMoney(point.assets, currency, locale)}
                    </span>
                    <span className="block text-xs text-muted-foreground @2xl:hidden">
                      {t('col.liabilities')} {formatMoney(point.liabilities, currency, locale)}
                    </span>
                  </td>
                  <td className={cn(cell, 'text-right')}>
                    <ChangeCell change={point.change} currency={currency} />
                  </td>
                </>
              ) : (
                <td colSpan={4} className={cn(cell, 'text-left text-muted-foreground')}>
                  {t('noRecord')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function ChangeCell({ change, currency }: { change: number | null; currency: string }) {
  if (change === null || change === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const up = change > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5',
        up ? 'text-positive' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{up ? '+' : '−'}</span>
      <MoneyAmount
        minor={Math.abs(change)}
        currency={currency}
        kind="neutral"
        size="sm"
        className={up ? 'text-positive' : 'text-muted-foreground'}
      />
    </span>
  );
}
