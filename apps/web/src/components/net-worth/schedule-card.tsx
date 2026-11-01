'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { formatMonth } from '@/lib/dates';
import {
  formatRate,
  repaidPercent,
  splitTerm,
  upcomingInstalments,
} from '@/lib/net-worth-schedule';
import type { ScheduleDto } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { Progress } from '../ui/progress';
import { ScheduleTable } from './schedule-table';
import { useFormatMoney } from '@/components/privacy';

/** The repayment plan of a mortgage or loan: the facts, how much is repaid, and the instalments. */
export function ScheduleCard({
  schedule,
  currency,
  currentBalance,
  today,
  divergence,
  canWrite,
  editHref,
}: {
  schedule: ScheduleDto | null;
  currency: string;
  /** What is owed today (the recorded balance when there is one, else the plan's). */
  currentBalance: number;
  today: string;
  divergence: { real: number; plan: number } | null;
  canWrite: boolean;
  editHref: string;
}) {
  const t = useTranslations('schedule');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const titleId = useId();
  const [all, setAll] = useState(false);
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const rows = useMemo(() => {
    if (!schedule) return [];
    const month = `${today.slice(0, 7)}-01`;
    return all
      ? schedule.rows.map((r) => ({ ...r, thisMonth: r.date.slice(0, 7) === month.slice(0, 7) }))
      : upcomingInstalments(schedule.rows, month, 12);
  }, [schedule, today, all]);

  if (!schedule) {
    return (
      <Card as="section" aria-labelledby={titleId} className="grid grid-cols-1 gap-3">
        <h2 id={titleId} className="text-card-title">
          {t('title')}
        </h2>
        <p className="max-w-[68ch] text-base text-muted-foreground">{t('none')}</p>
        {canWrite ? (
          <Link href={editHref} className={buttonVariants({ variant: 'outline' })}>
            {t('define')}
          </Link>
        ) : null}
      </Card>
    );
  }

  const { years, months } = splitTerm(schedule.remaining);
  const paid = Math.max(schedule.principal - currentBalance, 0);
  const percent = repaidPercent(schedule.principal, currentBalance);
  const repaidText = t('repaidText', {
    paid: money(Math.min(paid, schedule.principal)),
    principal: money(schedule.principal),
    percent,
  });

  return (
    <section aria-labelledby={titleId} className="grid grid-cols-1 gap-4">
      <Card className="grid grid-cols-1 gap-5">
        <h2 id={titleId} className="text-card-title">
          {t('title')}
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('payment')}</dt>
            <dd data-testid="schedule-payment">
              <MoneyAmount minor={schedule.payment} currency={currency} size="lg" />
            </dd>
          </div>
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('rate')}</dt>
            <dd className="text-base font-medium tabular-nums">
              {formatRate(schedule.annualRateBps, locale)}
            </dd>
          </div>
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('remaining')}</dt>
            <dd data-testid="schedule-remaining" className="grid grid-cols-1 text-base font-medium">
              <span>
                {schedule.remaining === 0
                  ? '—'
                  : t('term', { years, months, both: years > 0 && months > 0 ? 'yes' : 'no' })}
              </span>
              <span className="text-sm font-normal text-muted-foreground">
                {t('instalments', { count: schedule.remaining })}
              </span>
            </dd>
          </div>
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('end')}</dt>
            <dd className="text-base font-medium">{formatMonth(schedule.endDate, locale)}</dd>
          </div>
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('principal')}</dt>
            <dd>
              <MoneyAmount minor={schedule.principal} currency={currency} />
            </dd>
          </div>
          <div className="grid grid-cols-1 content-start gap-0.5">
            <dt className="text-label text-muted-foreground">{t('start')}</dt>
            <dd className="text-base font-medium">{formatMonth(schedule.startDate, locale)}</dd>
          </div>
        </dl>

        <div className="grid grid-cols-1 gap-2">
          <p className="text-sm font-medium">{t('repaid')}</p>
          <Progress
            label={t('repaid')}
            fill={percent / 100}
            valueNow={percent}
            valueText={repaidText}
          />
          <p className="text-sm tabular-nums text-muted-foreground">{repaidText}</p>
        </div>

        {divergence ? (
          <Alert tone="info">
            {t('divergence', { real: money(divergence.real), plan: money(divergence.plan) })}
          </Alert>
        ) : null}
      </Card>

      <ScheduleTable rows={rows} currency={currency} scroll={all} />
      <Button
        variant="ghost"
        className="h-auto min-h-11 justify-self-start whitespace-normal py-2 text-left"
        aria-expanded={all}
        onClick={() => setAll((v) => !v)}
      >
        {all ? t('showLess') : t('showAll', { count: schedule.rows.length })}
      </Button>
    </section>
  );
}
