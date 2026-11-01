'use client';

import { ArrowLeftRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { monthParam } from '@/lib/budget-period';
import { cn } from '@/lib/cn';
import type { PlanSummaryDto } from '@/server/budget-data';
import { useHouseholdFormat } from '../household-format';
import { Card, CardHeader } from '../ui/card';
import { useFormatMoney } from '@/components/privacy';

/**
 * The month's transfer plan in one line (what to move, or what is missing in the main account)
 * and the way into the full plan. "Por atribuir" itself is a tile of the summary strip.
 */
export function AllocationCard({
  unallocated,
  plan,
  month,
  budgetId,
}: {
  unallocated: { planned: number; actual: number };
  plan: PlanSummaryDto;
  month: string;
  /** Only when a budget was opened on purpose. */
  budgetId?: string;
}) {
  const t = useTranslations('budget.allocation');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const params = new URLSearchParams({ month: monthParam(month) });
  if (budgetId) params.set('budget', budgetId);

  const planLine = !plan.configured
    ? t('planChoose')
    : plan.negative
      ? t('planShort', { amount: money(Math.abs(plan.remainingInHub)) })
      : plan.accounts === 0
        ? t('planNothing')
        : t('planMove', { amount: money(plan.total), count: plan.accounts });
  const problem = plan.configured && plan.negative;

  return (
    <Card as="section" aria-labelledby="allocation-title">
      <CardHeader
        title={t('planLink')}
        titleId="allocation-title"
        icon={ArrowLeftRight}
        link={{ href: `/budget/transfers?${params.toString()}`, label: t('planOpen') }}
      />
      <p className={cn('text-base font-medium', problem ? 'text-negative' : 'text-foreground')}>
        {planLine}
      </p>
      {unallocated.planned < 0 ? (
        <p className="mt-1.5 text-sm font-medium text-negative">{t('planOverspends')}</p>
      ) : null}
    </Card>
  );
}
