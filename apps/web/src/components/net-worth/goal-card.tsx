'use client';

import { Pencil, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatMonth } from '@/lib/dates';
import { dateVerdict, goalState } from '@/lib/goals';
import { formatDayYear } from '@/lib/net-worth-format';
import type { GoalDto } from '@/server/goals-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { cn } from '@/lib/cn';
import { buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { GoalProgress } from './goal-progress';
import { useFormatMoney } from '@/components/privacy';

/**
 * One goal. With a target: saved, a meter, what is missing, the monthly contribution and the
 * expected month. Without one: only saved and the contribution, and a line saying why there is no
 * projection. The emergency fund adds how its target is worked out.
 */
export function GoalCard({
  goal,
  canWrite,
  isOwner,
  emergencyFundMonths,
}: {
  goal: GoalDto;
  canWrite: boolean;
  isOwner: boolean;
  emergencyFundMonths: number;
}) {
  const t = useTranslations('goals');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const state = goalState(goal);
  const emergency = goal.kind === 'emergency_fund';
  const verdict = dateVerdict(goal);
  const titleId = `goal-${goal.id}`;
  const average =
    emergency && goal.target !== null && emergencyFundMonths > 0
      ? Math.round(goal.target / emergencyFundMonths)
      : null;

  const source = goal.accountName
    ? t('sourceAccount', { account: goal.accountName })
    : goal.lineName
      ? t('sourceLine', { line: goal.lineName })
      : t('sourceNone', { zero: money(0) });

  return (
    <Card
      as="article"
      aria-labelledby={titleId}
      className="grid min-w-0 grid-cols-1 content-start gap-4"
    >
      <header className="flex items-start gap-2">
        <div className="grid grid-cols-1 min-w-0 flex-1 gap-1.5">
          <h2 id={titleId} className="break-words text-heading">
            {goal.name}
          </h2>
          {emergency ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-caption font-medium">
              <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
              {t('emergencyTag')}
            </span>
          ) : null}
        </div>
        {canWrite ? (
          <Link
            href={`/net-worth/goals/${goal.id}/edit`}
            aria-label={t('editLabel', { name: goal.name })}
            title={t('editLabel', { name: goal.name })}
            className={buttonVariants({ variant: 'ghost', size: 'icon', className: '-my-2 -mr-2' })}
          >
            <Pencil className="size-5" aria-hidden="true" />
          </Link>
        ) : null}
      </header>

      {state === 'open' || state === 'reached' ? (
        <div className="grid grid-cols-1 gap-3">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid="goal-saved">
              <MoneyAmount minor={goal.saved} currency={currency} kind="balance" size="lg" />
            </span>
            <span className="text-base text-muted-foreground">
              {t('of', { target: money(goal.target ?? 0) })}
            </span>
          </p>
          <GoalProgress
            name={goal.name}
            saved={goal.saved}
            target={goal.target ?? 0}
            progressBps={goal.progressBps}
            reached={state === 'reached'}
          />
        </div>
      ) : (
        <p data-testid="goal-saved">
          <MoneyAmount minor={goal.saved} currency={currency} kind="balance" size="lg" />
          <span className="sr-only"> {t('saved')}</span>
        </p>
      )}

      {state === 'no_budget' ? (
        <div className="grid grid-cols-1 justify-items-start gap-1">
          <p className="text-base text-muted-foreground">{t('emergencyNoBudget')}</p>
          {canWrite ? (
            <Link href="/budget/new" className={cn(buttonVariants({ variant: 'link' }), 'px-0')}>
              {t('createBudget')}
            </Link>
          ) : null}
        </div>
      ) : null}

      {state === 'no_target' ? (
        <dl className="grid grid-cols-1 gap-2 text-base">
          <Row label={t('contribution')}>
            {goal.contribution > 0 ? (
              t('perMonth', { amount: money(goal.contribution) })
            ) : (
              <span className="text-muted-foreground">{t('noContribution')}</span>
            )}
          </Row>
        </dl>
      ) : null}
      {state === 'no_target' ? (
        <p className="text-sm text-muted-foreground">{t('noTarget')}</p>
      ) : null}

      {state === 'open' || state === 'reached' ? (
        <dl className="grid grid-cols-1 gap-2.5 rounded-md bg-surface-2 p-3 text-base md:p-4">
          <Row label={t('remaining')} testId="goal-remaining">
            {goal.remaining === 0 ? t('nothing') : money(goal.remaining)}
          </Row>
          <Row label={t('contribution')}>
            {goal.contribution > 0 ? (
              t('perMonth', { amount: money(goal.contribution) })
            ) : (
              <span className="text-muted-foreground">{t('noContribution')}</span>
            )}
          </Row>
          <Row label={t('expected')} testId="goal-expected">
            {state === 'reached' ? (
              t('alreadyReached')
            ) : goal.expectedDate && goal.months !== null ? (
              <>
                {formatMonth(goal.expectedDate, locale)}
                <span className="block text-sm font-normal text-muted-foreground">
                  {t('expectedIn', { count: goal.months })}
                </span>
              </>
            ) : (
              '—'
            )}
          </Row>
        </dl>
      ) : null}

      {state === 'open' && goal.months === null ? (
        <p className="-mt-2 text-sm text-muted-foreground">{t('expectedNone')}</p>
      ) : null}

      {verdict === 'late' && goal.targetDate ? (
        <p className="flex items-start gap-1.5 text-sm font-medium text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t('late', { date: formatDayYear(goal.targetDate, locale) })}
        </p>
      ) : null}
      {verdict === 'on_time' && goal.targetDate ? (
        <p className="text-sm text-muted-foreground">
          {t('onTime', { date: formatDayYear(goal.targetDate, locale) })}
        </p>
      ) : null}

      {emergency && state !== 'no_budget' ? (
        <div className="grid grid-cols-1 justify-items-start gap-1">
          <p className="max-w-[68ch] text-sm text-muted-foreground">
            {average !== null
              ? t('emergencyExplain', { avg: money(average), months: emergencyFundMonths })
              : t('emergencyZero')}
          </p>
          {isOwner ? (
            <Link
              href="/settings/household#emergency-fund"
              className={cn(buttonVariants({ variant: 'link' }), 'px-0')}
            >
              {t('emergencyChange')}
            </Link>
          ) : null}
        </div>
      ) : null}

      <p className="border-t border-border pt-3 text-sm text-muted-foreground">{source}</p>
    </Card>
  );
}

function Row({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}
