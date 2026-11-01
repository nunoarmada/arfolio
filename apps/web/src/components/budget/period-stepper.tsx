'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { monthParam } from '@/lib/budget-period';
import { addMonths, formatMonth } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';

const capitalise = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/**
 * "‹ outubro de 2026 ›": two 44px links that change `?month=` (so Back works) around a live
 * label, plus a way back to the current month. `min` and `max` (first-of-month dates) stop the
 * arrows at the ends of a budget that was opened on purpose.
 */
export function PeriodStepper({
  month,
  todayMonth,
  basePath,
  budgetId,
  min,
  max,
  hrefFor,
  label: labelOverride,
  inline = false,
  className,
}: {
  month: string;
  todayMonth: string;
  basePath: string;
  budgetId?: string;
  min?: string;
  max?: string;
  /** Builds the link for a month instead of `?month=` on `basePath` (Análises keeps its own parameters). */
  hrefFor?: (month: string) => string;
  /** The visible label when it is not the month itself (a period of several months). */
  label?: string;
  /** In a toolbar or the tab row: no bottom margin, and 36px arrows for fine pointers from md. */
  inline?: boolean;
  className?: string;
}) {
  const t = useTranslations('budget.stepper');
  const { locale } = useHouseholdFormat();
  const label = (m: string) => capitalise(formatMonth(m, locale));
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const href = (m: string) => {
    if (hrefFor) return hrefFor(m);
    const params = new URLSearchParams({ month: monthParam(m) });
    if (budgetId) params.set('budget', budgetId);
    return `${basePath}?${params.toString()}`;
  };
  const hasPrev = !min || prev >= min;
  const hasNext = !max || next <= max;
  const arrow = cn(
    'flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2',
    inline && 'md:pointer-fine:size-9',
  );
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', !inline && 'mb-4', className)}
    >
      <div className="flex items-center">
        {hasPrev ? (
          <Link
            href={href(prev)}
            aria-label={t('previous', { month: label(prev) })}
            className={arrow}
          >
            <ChevronLeft className="size-6" aria-hidden="true" />
          </Link>
        ) : (
          <span className={cn(arrow, 'text-subtle-foreground')} aria-hidden="true">
            <ChevronLeft className="size-6" />
          </span>
        )}
        <span
          aria-live="polite"
          className={cn(
            'px-1 text-center text-base font-semibold',
            inline ? 'min-w-36 md:text-sm' : 'min-w-40',
          )}
          data-testid="period-label"
        >
          {labelOverride ?? label(month)}
        </span>
        {hasNext ? (
          <Link href={href(next)} aria-label={t('next', { month: label(next) })} className={arrow}>
            <ChevronRight className="size-6" aria-hidden="true" />
          </Link>
        ) : (
          <span className={cn(arrow, 'text-subtle-foreground')} aria-hidden="true">
            <ChevronRight className="size-6" />
          </span>
        )}
      </div>
      {month !== todayMonth && (!min || todayMonth >= min) && (!max || todayMonth <= max) ? (
        <Link
          href={href(todayMonth)}
          className={cn(
            'inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-2 text-base text-primary-text hover:underline',
            inline && 'md:text-sm md:pointer-fine:min-h-9',
          )}
        >
          {t('today')}
        </Link>
      ) : null}
    </div>
  );
}
