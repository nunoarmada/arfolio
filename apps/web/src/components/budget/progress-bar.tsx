'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { barModel, type BudgetKind } from '@/lib/budget-status';
import type { MonthState } from '@/lib/budget-period';
import { useHouseholdFormat } from '../household-format';
import { Progress } from '../ui/progress';
import { useFormatMoney } from '@/components/privacy';

/**
 * Planned against actual as a meter. The fill never carries the status alone: the row names it in
 * words, the over-spending end is hatched, and `aria-valuetext` is a full sentence.
 */
export function BudgetProgressBar({
  kind,
  planned,
  actual,
  state,
  pace = null,
  paceCaption,
  compact = false,
  label,
  noData = false,
  className,
}: {
  kind: BudgetKind;
  planned: number;
  actual: number;
  state: MonthState;
  /** How far through the month today is (0..1); only used for expenses in the current month. */
  pace?: number | null;
  /** Caption under the pace tick ("Hoje"). */
  paceCaption?: ReactNode;
  compact?: boolean;
  /** The accessible name: the line or the summary this bar belongs to. */
  label: string;
  /** Saving line with no snapshot to read: no figure to show. */
  noData?: boolean;
  className?: string;
}) {
  const t = useTranslations('budget.meter');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const m = barModel(kind, planned, actual, state, pace);
  const money = (minor: number) => formatMoney(minor, currency, locale);

  const text = noData
    ? t('noData')
    : state === 'future'
      ? t('planned', { planned: money(planned) })
      : kind === 'expense' && planned === 0 && actual > 0
        ? t('unplanned', { actual: money(actual) })
        : planned === 0
          ? t('none')
          : m.over > 0
            ? t('over', { actual: money(actual), planned: money(planned), over: money(m.over) })
            : t('of', {
                actual: money(actual),
                planned: money(planned),
                percent: m.percent ?? 0,
              });

  return (
    <Progress
      fill={m.fill}
      tone={m.tone}
      hatch={m.hatch}
      pace={m.pace}
      paceCaption={paceCaption}
      compact={compact}
      label={label}
      valueNow={m.percent ?? 0}
      valueText={text}
      className={className}
    />
  );
}
