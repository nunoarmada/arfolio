'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { cn } from '@/lib/cn';
import { formatDayYear } from '@/lib/net-worth-format';
import type { HistoryEntryDto } from '@/server/net-worth-data';
import {
  deleteAssetValuationAction,
  deleteLiabilityBalanceAction,
} from '@/server/actions/net-worth';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/**
 * The valuations or balances of a record, newest first: a list on phones, a real table from md
 * up. Writers can delete a row; focus then moves to the next row's delete button, or to the
 * section heading when none is left.
 *
 * Radix returns focus to the dialog's trigger once the exit animation is over, which can be after
 * the deletion went through but before the refreshed list has dropped the row. The trigger would
 * take focus from the heading and then vanish, leaving focus on the body. So the deleted row's
 * dialog skips that return and puts focus on the target itself (`onCloseAutoFocus`).
 */
export function HistoryList({
  mode,
  entries,
  currency,
  canWrite,
  headingId,
}: {
  mode: 'asset' | 'liability';
  entries: HistoryEntryDto[];
  currency: string;
  canWrite: boolean;
  headingId: string;
}) {
  const t = useTranslations(mode);
  const common = useTranslations('common');
  const { locale } = useHouseholdFormat();
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, start] = useTransition();
  const [focusNext, setFocusNext] = useState<string | 'heading' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The row whose deletion succeeded and where focus belongs now; read by that row's dialog.
  const deleted = useRef<{ id: string; next: string | 'heading' } | null>(null);

  function focusTarget(next: string | 'heading') {
    const target =
      next === 'heading'
        ? document.getElementById(headingId)
        : [
            ...(root.current?.querySelectorAll<HTMLElement>(`[data-delete-id="${next}"]`) ?? []),
          ].find((el) => el.offsetParent !== null);
    target?.focus();
  }

  // After a row is gone, put focus where the reader was working.
  useEffect(() => {
    if (focusNext === null) return;
    if (focusNext !== 'heading' && !entries.some((e) => e.id === focusNext)) return;
    focusTarget(focusNext);
    setFocusNext(null);
  }, [entries, focusNext, headingId]);

  function remove(entry: HistoryEntryDto) {
    const index = entries.findIndex((e) => e.id === entry.id);
    const next = entries[index + 1] ?? entries[index - 1];
    deleted.current = null;
    start(async () => {
      const result =
        mode === 'asset'
          ? await deleteAssetValuationAction(entry.id)
          : await deleteLiabilityBalanceAction(entry.id);
      if (!result.ok) {
        toast.error(failure(result));
        return;
      }
      toast.success(t('deleted'));
      const target = next ? next.id : 'heading';
      deleted.current = { id: entry.id, next: target };
      setFocusNext(target);
      router.refresh();
    });
  }

  const method = (m: string) => t(`method.${m}`);
  const deleteButton = (entry: HistoryEntryDto) => (
    <ConfirmDialog
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="md:size-9"
          data-delete-id={entry.id}
          aria-label={t('delete', { date: formatDayYear(entry.asOf, locale) })}
        >
          <Trash2 className="size-5" aria-hidden="true" />
        </Button>
      }
      title={t('deleteTitle')}
      description={t('deleteBody', { date: formatDayYear(entry.asOf, locale) })}
      confirmLabel={t('deleteConfirm')}
      cancelLabel={common('cancel')}
      onConfirm={() => remove(entry)}
      onCloseAutoFocus={(event) => {
        // Cancel and Escape keep the default: focus goes back to this row's button.
        if (deleted.current?.id !== entry.id) return;
        event.preventDefault();
        focusTarget(deleted.current.next);
        deleted.current = null;
      }}
      pending={pending}
    />
  );
  const owed = mode === 'liability';

  return (
    <div ref={root}>
      <ul className="divide-y overflow-hidden rounded-lg bg-surface shadow-card md:hidden">
        {entries.map((entry) => (
          <li key={entry.id} className="flex min-h-16 items-center gap-3 px-4 py-2">
            <span className="grid min-w-0 flex-1 grid-cols-1">
              <span className="text-base tabular-nums">{formatDayYear(entry.asOf, locale)}</span>
              <span className="truncate text-sm text-muted-foreground">
                {method(entry.method)}
                {entry.note ? ` · ${entry.note}` : ''}
              </span>
            </span>
            <MoneyAmount
              minor={entry.amount}
              currency={currency}
              kind={owed ? 'neutral' : 'balance'}
            />
            {canWrite ? deleteButton(entry) : null}
          </li>
        ))}
      </ul>
      <ScrollRegion label={t('history')} className="hidden md:block">
        <table className={cn(dataTable.table, 'min-w-[30rem] table-fixed')}>
          <colgroup>
            <col className="w-[7.5rem]" />
            <col className="w-[9rem]" />
            <col className="w-[7rem]" />
            <col />
            {canWrite ? <col className="w-[3rem]" /> : null}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={dataTable.th}>
                {t('col.date')}
              </th>
              <th scope="col" className={cn(dataTable.th, dataTable.thNum)}>
                {t('col.value')}
              </th>
              <th scope="col" className={dataTable.th}>
                {t('col.source')}
              </th>
              <th scope="col" className={dataTable.th}>
                {t('col.note')}
              </th>
              {canWrite ? (
                <th scope="col" className={cn(dataTable.th, 'px-1 last:pr-1')}>
                  <span className="sr-only">{t('col.action')}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className={dataTable.row}>
                <th
                  scope="row"
                  className={cn(
                    dataTable.td,
                    'whitespace-nowrap text-left font-normal tabular-nums',
                  )}
                >
                  {formatDayYear(entry.asOf, locale)}
                </th>
                <td className={cn(dataTable.td, dataTable.tdNum)}>
                  <MoneyAmount
                    minor={entry.amount}
                    currency={currency}
                    kind={owed ? 'neutral' : 'balance'}
                    size="sm"
                  />
                </td>
                <td className={cn(dataTable.td, 'text-muted-foreground')}>
                  <span className={dataTable.truncate}>{method(entry.method)}</span>
                </td>
                <td className={cn(dataTable.td, 'text-muted-foreground')}>
                  <span className={dataTable.truncate} title={entry.note ?? undefined}>
                    {entry.note ?? ''}
                  </span>
                </td>
                {canWrite ? (
                  <td className={cn(dataTable.td, 'px-1 text-center last:pr-1')}>
                    {deleteButton(entry)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
