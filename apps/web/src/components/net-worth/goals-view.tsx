'use client';

import { CalendarClock, PiggyBank, Plus, Target, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { GoalsPageData } from '@/server/goals-data';
import { EmptyState } from '../empty-state';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { cn } from '@/lib/cn';
import { dateVerdict } from '@/lib/goals';
import { buttonVariants } from '../ui/button';
import { KpiTile } from '../ui/kpi-tile';
import { GoalCard } from './goal-card';

/** The Objetivos page body: what is saved in total, then one card per goal (or the empty state). */
export function GoalsView({
  data,
  canWrite,
  isOwner,
}: {
  data: GoalsPageData;
  canWrite: boolean;
  isOwner: boolean;
}) {
  const t = useTranslations('goals');
  const { currency } = useHouseholdFormat();

  if (data.goals.length === 0) {
    return (
      <EmptyState
        title={t('emptyTitle')}
        action={
          canWrite ? (
            <div className="flex flex-wrap gap-3">
              <Link href="/net-worth/goals/new" className={buttonVariants({})}>
                {t('add')}
              </Link>
              {data.hasEmergencyFund ? null : (
                <Link
                  href="/net-worth/goals/new?kind=emergency_fund"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('addEmergency')}
                </Link>
              )}
            </div>
          ) : undefined
        }
      >
        {t('emptyBody')}
      </EmptyState>
    );
  }

  // Only goals with a target have something left to reach.
  const remaining = data.goals.reduce((sum, g) => sum + (g.target ? g.remaining : 0), 0);
  const contribution = data.goals.reduce((sum, g) => sum + g.contribution, 0);
  const late = data.goals.filter((g) => dateVerdict(g) === 'late').length;

  return (
    <div className="grid grid-cols-1 gap-4 xl:gap-6">
      <div
        role="group"
        aria-label={t('kpi.label')}
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
      >
        <KpiTile
          hero
          testId="goals-total-saved"
          label={t('kpi.saved')}
          icon={PiggyBank}
          value={
            <MoneyAmount
              minor={data.totalSaved}
              currency={currency}
              kind="balance"
              size="kpi"
              dimCents
            />
          }
          comparison={t('kpi.savedNote', { count: data.goals.length })}
        />
        <KpiTile
          label={t('kpi.remaining')}
          icon={Target}
          value={<MoneyAmount minor={remaining} currency={currency} kind="neutral" size="kpi" />}
          comparison={t('kpi.remainingNote')}
        />
        <KpiTile
          label={t('kpi.contribution')}
          icon={TrendingUp}
          value={<MoneyAmount minor={contribution} currency={currency} kind="neutral" size="kpi" />}
          comparison={t('kpi.contributionNote')}
        />
        <KpiTile
          label={t('kpi.late')}
          icon={CalendarClock}
          value={
            <span className="money-hero text-kpi tabular-nums" data-testid="goals-late-count">
              {late}
            </span>
          }
          comparison={late > 0 ? t('kpi.lateSome', { count: late }) : t('kpi.lateNone')}
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.goals.map((goal) => (
          <GoalCard
            key={goal.id}
            goal={goal}
            canWrite={canWrite}
            isOwner={isOwner}
            emergencyFundMonths={data.emergencyFundMonths}
          />
        ))}
      </div>
      {canWrite && !data.hasEmergencyFund ? (
        <p>
          <Link
            href="/net-worth/goals/new?kind=emergency_fund"
            className={cn(buttonVariants({ variant: 'link' }), 'px-0')}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('addEmergency')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
