'use client';

import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { cn } from '@/lib/cn';
import { formatMonthRelative } from '@/lib/net-worth-format';
import { useHouseholdFormat } from '../household-format';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';

export type Change =
  | { kind: 'up' | 'down' | 'flat'; amount: number; prevMonth: string }
  | { kind: 'first' }
  | { kind: 'unknown' };

/** The change from the previous month as a plain sentence (for the chart's value text). */
export function useChangeSentence(currentMonth: string) {
  const t = useTranslations('netWorth.change');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  return useCallback(
    (change: Change): string => {
      if (change.kind === 'first' || change.kind === 'unknown') return t('first');
      const month = formatMonthRelative(change.prevMonth, currentMonth, locale);
      const amount = formatMoney(change.amount, currency, locale);
      if (change.kind === 'up') return t('up', { amount: `+${amount}`, month });
      if (change.kind === 'down') return t('down', { amount: `${MINUS}${amount}`, month });
      return t('flat', { month });
    },
    [t, currentMonth, locale, currency, formatMoney],
  );
}

/**
 * The month-over-month change: arrow, word, signed amount and colour together, never colour
 * alone. `compact` drops the word from the visible text (the arrow and sign carry it) and keeps
 * it for screen readers.
 */
export function ChangeLabel({
  change,
  currentMonth,
  compact = false,
  className,
}: {
  change: Change;
  currentMonth: string;
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations('netWorth.change');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const sentence = useChangeSentence(currentMonth);
  if (change.kind === 'unknown') return null;
  if (change.kind === 'first') {
    return <span className={cn('text-sm text-muted-foreground', className)}>{t('first')}</span>;
  }
  const Icon =
    change.kind === 'up' ? ArrowUpRight : change.kind === 'down' ? ArrowDownRight : Minus;
  const tone =
    change.kind === 'up'
      ? 'text-positive'
      : change.kind === 'down'
        ? 'text-negative'
        : 'text-muted-foreground';
  const month = formatMonthRelative(change.prevMonth, currentMonth, locale);
  if (compact && change.kind !== 'flat') {
    const amount = formatMoney(change.amount, currency, locale);
    const word = t(change.kind === 'up' ? 'upWord' : 'downWord');
    return (
      <span
        className={cn(
          'inline-flex flex-wrap items-center gap-x-1.5 text-base tabular-nums',
          className,
        )}
      >
        <span className={cn('inline-flex items-center gap-1 font-medium', tone)}>
          <Icon className="size-5 shrink-0" aria-hidden="true" />
          <span className="sr-only">{word} </span>
          {change.kind === 'up' ? '+' : MINUS}
          {amount}
        </span>
        <span className="text-muted-foreground">{t('vs', { month })}</span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-base font-medium', tone, className)}>
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{sentence(change)}</span>
    </span>
  );
}
