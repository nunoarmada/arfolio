'use client';

import { useTranslations } from 'next-intl';
import {
  insightsHref,
  insightsRange,
  MAX_END_BACK,
  RANGE_KEYS,
  type InsightsParams,
} from '@/lib/insights-chart';
import { rangeLabel } from '@/lib/insights-format';
import { shiftMonth } from '@/lib/net-worth-chart';
import { PeriodStepper } from '../budget/period-stepper';
import { useHouseholdFormat } from '../household-format';
import { SegmentedNav } from '../ui/segmented-nav';

/**
 * The period of the whole page, kept in the URL: "Mês · 3 meses · 12 meses" as links, and the
 * month stepper that moves the last month of the period. Both keep what they do not change
 * (`account`), and every step is a navigation, so Back walks through the choices.
 */
export function InsightsControls({
  params,
  currentMonth,
}: {
  params: InsightsParams;
  currentMonth: string;
}) {
  const t = useTranslations('insights');
  const { locale } = useHouseholdFormat();
  const months = insightsRange(params.range, params.end).months;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <SegmentedNav
        label={t('period.label')}
        current="page"
        items={RANGE_KEYS.map((key) => ({
          href: insightsHref({ ...params, range: key }, currentMonth),
          label: t(`period.r${key}`),
          active: key === params.range,
        }))}
      />
      <div className="flex flex-wrap items-center gap-x-2">
        <PeriodStepper
          month={params.end}
          todayMonth={currentMonth}
          basePath="/insights"
          min={shiftMonth(currentMonth, -MAX_END_BACK)}
          max={currentMonth}
          hrefFor={(month) => insightsHref({ ...params, end: month }, currentMonth)}
          label={params.range === 1 ? undefined : rangeLabel(months, locale)}
          className="mb-0"
        />
        {params.end === currentMonth ? (
          <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-caption font-medium text-muted-foreground">
            {t('inProgress')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
