'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import type { TrendRow } from '@/lib/insights-chart';
import { formatMonthShort } from '@/lib/dates';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { ROW_HEAD, TableRegion, TH, TH_FIRST } from './section-card';

/**
 * The trends as a table, newest month first. The live month is tagged and the months of the
 * page's period are shaded and named for screen readers.
 */
export function TrendsTable({
  rows,
  selected,
  currentMonth,
}: {
  rows: TrendRow[];
  selected: readonly string[];
  currentMonth: string;
}) {
  const t = useTranslations('insights.trends');
  const common = useTranslations('insights');
  const { locale, currency } = useHouseholdFormat();
  const keys = ['income', 'expense', 'saving', 'net'] as const;
  const kind = { income: 'income', expense: 'expense', saving: 'balance', net: 'balance' } as const;
  const newest = [...rows].reverse();
  return (
    <div data-testid="insights-trends-table">
      {/* Phones: one block per month, the four figures as a definition list (no sideways scroll). */}
      <ul className="grid grid-cols-1 gap-2 md:hidden">
        {newest.map((r) => {
          const inPeriod = selected.includes(r.month);
          return (
            <li
              key={r.month}
              data-month={r.month.slice(0, 7)}
              className={cn(
                'rounded-md p-3',
                inPeriod ? 'bg-surface-2' : 'shadow-[0_0_0_1px_var(--border)]',
              )}
            >
              <p className="mb-2 text-sm font-semibold">
                {formatMonthShort(r.month, locale, true)}
                {r.month === currentMonth ? ` (${common('inProgress')})` : ''}
                {inPeriod ? <span className="sr-only"> — {t('selectedSr')}</span> : null}
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {keys.map((key) => (
                  <div key={key} className="grid grid-cols-1 gap-0.5">
                    <dt className="text-label text-muted-foreground">{t(key)}</dt>
                    <dd>
                      <MoneyAmount minor={r[key]} currency={currency} kind={kind[key]} size="sm" />
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
        <TableRegion label={t('title')}>
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className={TH_FIRST}>
                {t('col.month')}
              </th>
              {keys.map((key) => (
                <th key={key} scope="col" className={cn(TH, 'text-right')}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {newest.map((r) => {
              const inPeriod = selected.includes(r.month);
              return (
                <tr
                  key={r.month}
                  data-month={r.month.slice(0, 7)}
                  className={inPeriod ? 'bg-surface-2' : 'bg-surface'}
                >
                  <th scope="row" className={ROW_HEAD}>
                    {formatMonthShort(r.month, locale, true)}
                    {r.month === currentMonth ? ` (${common('inProgress')})` : ''}
                    {inPeriod ? <span className="sr-only"> — {t('selectedSr')}</span> : null}
                  </th>
                  {keys.map((key) => (
                    <td key={key} className="px-3 py-2 text-right">
                      <MoneyAmount minor={r[key]} currency={currency} kind={kind[key]} size="sm" />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </TableRegion>
      </div>
    </div>
  );
}
