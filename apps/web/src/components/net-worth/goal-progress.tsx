'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { progressPercent } from '@/lib/goals';
import { useHouseholdFormat } from '../household-format';
import { Progress } from '../ui/progress';
import { useFormatMoney } from '@/components/privacy';

/**
 * Saved against target as a meter: a full-sentence `aria-valuetext`, the percentage in words next
 * to the bar, and a check plus "Objetivo atingido" instead of a colour change alone at 100 %.
 */
export function GoalProgress({
  name,
  saved,
  target,
  progressBps,
  reached,
}: {
  name: string;
  saved: number;
  target: number;
  progressBps: number | null;
  reached: boolean;
}) {
  const t = useTranslations('goals');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const percent = reached ? 100 : progressPercent(progressBps);
  const text = t('progressText', {
    saved: formatMoney(saved, currency, locale),
    target: formatMoney(target, currency, locale),
    percent,
  });
  return (
    <div className="flex items-center gap-3">
      <Progress
        className="min-w-0 flex-1"
        label={t('progressLabel', { name })}
        fill={percent / 100}
        tone={reached ? 'positive' : 'primary'}
        valueNow={percent}
        valueText={text}
      />
      {reached ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-positive">
          <Check className="size-4" aria-hidden="true" />
          {t('reached')}
        </span>
      ) : (
        <span aria-hidden="true" className="w-11 shrink-0 text-right text-sm tabular-nums">
          {t('percent', { percent })}
        </span>
      )}
    </div>
  );
}
