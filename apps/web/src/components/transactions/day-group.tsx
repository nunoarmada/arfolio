'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { dayHeading } from '@/lib/dates';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';

/**
 * One day of the feed: a sticky band (surface-2, date left, the day's net total right) and a
 * divided list of rows. Days stack inside the single Card of the list (the parent rounds the first
 * band and the last list), so the page reads as one ledger. The total excludes transfers and
 * pending rows; `total` is null while the day may still continue on the next page.
 */
export function DayGroup({
  date,
  today,
  total,
  currency,
  children,
}: {
  date: string;
  today: string;
  total: number | null;
  currency: string | null;
  children: ReactNode;
}) {
  const t = useTranslations('transactions');
  const { locale } = useHouseholdFormat();
  const id = `day-${date}`;
  return (
    <section aria-labelledby={id} className="grid grid-cols-1">
      <h3
        id={id}
        className="sticky top-14 z-10 flex h-9 items-center justify-between gap-3 bg-surface-2 px-4 text-label font-semibold shadow-[0_1px_0_var(--border)] md:top-0"
      >
        <span className="min-w-0 truncate">
          {dayHeading(date, today, locale, { today: t('today'), yesterday: t('yesterday') })}
        </span>
        {total !== null && currency ? (
          <MoneyAmount
            minor={total}
            currency={currency}
            kind={total > 0 ? 'income' : 'neutral'}
            size="sm"
            className="shrink-0 whitespace-nowrap font-semibold text-muted-foreground"
          />
        ) : null}
      </h3>
      <ul className="divide-y divide-border overflow-hidden">{children}</ul>
    </section>
  );
}
