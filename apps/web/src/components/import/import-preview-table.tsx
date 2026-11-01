'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { rowErrorKey } from '@/lib/import-errors';
import type { PreviewRowDto } from '@/server/actions/imports';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { ScrollRegion } from '../ui/scroll-region';
import { dataTable } from '../ui/data-table';

function useRowStatus() {
  const t = useTranslations('import.preview');
  const errors = useTranslations('import.rowErrors');
  return (row: PreviewRowDto): { label: string; tone: 'ok' | 'muted' | 'error' } => {
    if (row.status === 'error') {
      const { key, values } = rowErrorKey(row.error ?? '');
      return { label: errors(key, values), tone: 'error' };
    }
    if (row.status === 'skipped')
      return { label: t(`skipped.${row.reason ?? 'summary'}`), tone: 'muted' };
    if (row.duplicate) return { label: t('statusDuplicate'), tone: 'muted' };
    return { label: row.pending ? t('statusPending') : t('statusNew'), tone: 'ok' };
  };
}

const toneClass = {
  ok: 'text-foreground',
  muted: 'text-muted-foreground',
  error: 'text-negative',
} as const;

/**
 * Parsed rows with their status; errors are in the row, in words. One table at every width, in a
 * scroll region with a sticky header and line column, so a phone scrolls it sideways with edge
 * shadows instead of getting a second layout.
 */
export function ImportPreviewTable({ rows }: { rows: PreviewRowDto[] }) {
  const t = useTranslations('import.preview');
  const { locale } = useHouseholdFormat();
  const status = useRowStatus();

  const amount = (row: PreviewRowDto) =>
    row.amount !== undefined && row.currency ? (
      <MoneyAmount
        minor={row.amount}
        currency={row.currency}
        kind={row.amount < 0 ? 'expense' : 'income'}
        pending={row.pending}
      />
    ) : null;

  return (
    <ScrollRegion
      label={t('tableCaption')}
      scrollerClassName="max-h-[28rem] overscroll-contain"
      testId="import-preview"
    >
      <table className={`${dataTable.table} min-w-[34rem]`}>
        <caption className="sr-only">{t('tableCaption')}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(dataTable.th, dataTable.stickyFirstHead, 'sticky top-0 z-20')}
            >
              {t('colLine')}
            </th>
            <th scope="col" className={cn(dataTable.th, 'sticky top-0 z-10')}>
              {t('colDate')}
            </th>
            <th scope="col" className={cn(dataTable.th, 'sticky top-0 z-10')}>
              {t('colDescription')}
            </th>
            <th scope="col" className={cn(dataTable.th, dataTable.thNum, 'sticky top-0 z-10')}>
              {t('colAmount')}
            </th>
            <th scope="col" className={cn(dataTable.th, 'sticky top-0 z-10')}>
              {t('colStatus')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const s = status(row);
            return (
              <tr key={row.line} className={dataTable.row}>
                <td
                  className={cn(
                    dataTable.td,
                    dataTable.stickyFirst,
                    'tabular-nums text-muted-foreground',
                  )}
                >
                  {row.line}
                </td>
                <td className={cn(dataTable.td, 'whitespace-nowrap tabular-nums')}>
                  {row.date ? formatDate(row.date, locale) : ''}
                </td>
                <td className={cn(dataTable.td, 'min-w-[12rem] max-w-[28ch]')}>
                  <span className={dataTable.truncate} title={row.description ?? undefined}>
                    {row.description ?? ''}
                  </span>
                </td>
                <td className={cn(dataTable.td, dataTable.tdNum, 'whitespace-nowrap')}>
                  {amount(row)}
                </td>
                <td className={cn(dataTable.td, 'whitespace-nowrap', toneClass[s.tone])}>
                  {s.label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
