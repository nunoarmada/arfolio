'use client';

import { Clock, Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BudgetLineView } from '@arfolio/services';
import { truncateName } from '@/lib/budget-import-copy';
import type { MonthState } from '@/lib/budget-period';
import { linePace, lineStatus } from '@/lib/budget-status';
import { formatShortDay } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { BudgetProgressBar } from './progress-bar';
import { StatusLabel } from './status-label';
import { useFormatMoney } from '@/components/privacy';

/**
 * Column template of the one-line row. It is used by the rows and by the (visual) header above
 * them, and only applies once the sections column is at least 600px wide (container query), so
 * the two-line phone layout also serves tablets and the narrow desktop column.
 */
export const WIDE_COLUMNS =
  '@[600px]:grid-cols-[minmax(120px,1fr)_minmax(64px,112px)_88px_88px_120px] @[600px]:gap-x-3';

/** Words above the columns of the one-line layout (hidden from assistive technology). */
export function LineColumnHeader() {
  const t = useTranslations('budget.columns');
  return (
    <div
      aria-hidden="true"
      className={cn(
        'hidden border-b bg-surface-2 px-4 py-2 text-label font-medium text-muted-foreground @[600px]:grid',
        WIDE_COLUMNS,
      )}
    >
      <span>{t('line')}</span>
      <span />
      <span className="text-right">{t('actual')}</span>
      <span className="text-right">{t('planned')}</span>
      <span className="text-right">{t('status')}</span>
    </div>
  );
}

/**
 * One budget line: name and status word, the meter, and "real de previsto". The whole row opens
 * the line's sheet. Pending and foreign-currency movements are noted beside, never in the bar.
 */
export function BudgetLineRow({
  line,
  state,
  pace,
  onOpen,
}: {
  line: BudgetLineView;
  state: MonthState;
  pace: number | null;
  onOpen: () => void;
}) {
  const t = useTranslations('budget.row');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const rowPace = linePace(pace, line);
  const status = lineStatus(line.kind, line.planned, line.actual, state, rowPace, {
    noData: line.noData,
  });
  const noData = status.key === 'noData';
  const name = truncateName(line.name, 60);
  const chips =
    line.pending !== 0 || line.foreignCurrencyRows > 0 || line.staleAsOf ? (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
        {line.pending !== 0 ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5 shrink-0" aria-hidden="true" />
            <span aria-hidden="true">
              {t('pending', { amount: money(Math.abs(line.pending)) })}
            </span>
            <span className="sr-only">
              {t('pendingSr', { amount: money(Math.abs(line.pending)) })}
            </span>
          </span>
        ) : null}
        {line.staleAsOf ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{t('staleAsOf', { date: formatShortDay(line.staleAsOf, locale) })}</span>
          </span>
        ) : null}
        {line.foreignCurrencyRows > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Globe className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t('foreign')}</span>
          </span>
        ) : null}
      </span>
    ) : null;

  return (
    <button
      type="button"
      id={`line-${line.lineId}`}
      onClick={onOpen}
      className={cn(
        'grid min-h-[76px] w-full grid-cols-[minmax(0,1fr)_auto] content-center gap-x-3 gap-y-2 px-4 py-3 text-left transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        '@[600px]:min-h-14 @[600px]:items-center @[600px]:gap-y-1 @[600px]:py-2.5',
        WIDE_COLUMNS,
      )}
    >
      <span
        className="col-start-1 row-start-1 min-w-0 truncate text-base font-medium"
        title={line.name}
      >
        {name}
      </span>
      <span className="col-start-2 row-start-1 text-right @[600px]:col-start-5">
        <StatusLabel status={status} className="justify-end text-right @[600px]:leading-tight" />
      </span>
      <span className="col-span-2 row-start-2 @[600px]:col-span-1 @[600px]:col-start-2 @[600px]:row-start-1">
        <BudgetProgressBar
          kind={line.kind}
          planned={line.planned}
          actual={line.actual}
          state={state}
          pace={rowPace}
          label={name}
          noData={noData}
        />
      </span>
      <span className="col-span-2 row-start-3 flex items-center justify-between gap-2 text-sm tabular-nums text-muted-foreground @[600px]:contents">
        <span className="@[600px]:contents">
          <span className="@[600px]:col-start-3 @[600px]:row-start-1 @[600px]:text-right @[600px]:font-medium @[600px]:text-foreground">
            <span className="sr-only hidden @[600px]:inline">{t('actualSr')} </span>
            {noData ? (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">{t('noData')}</span>
              </>
            ) : (
              money(line.actual)
            )}
          </span>
          <span className="@[600px]:hidden"> {t('of')} </span>
          <span className="@[600px]:col-start-4 @[600px]:row-start-1 @[600px]:text-right">
            <span className="sr-only hidden @[600px]:inline">{t('plannedSr')} </span>
            {money(line.planned)}
          </span>
        </span>
        <span className="@[600px]:col-start-1 @[600px]:row-start-2">{chips}</span>
      </span>
    </button>
  );
}
