import { budgetStartFor } from '@arfolio/core';
import { budgetMonthView, transferPlan } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArchivedNotice } from '@/components/budget/archived-notice';
import { BudgetNav } from '@/components/budget/budget-nav';
import { NoBudget } from '@/components/budget/no-budget';
import { PeriodStepper } from '@/components/budget/period-stepper';
import { TransferPlanView } from '@/components/budget/transfer-plan-view';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { formatBudgetRange, lastMonth, monthParam, nearestCoveredMonth } from '@/lib/budget-period';
import { formatMonth, monthStart, todayIn } from '@/lib/dates';
import { resolveBudget } from '@/server/budget-data';
import { getHouseholdSettings } from '@/server/household';
import { loadHouseholdFormat } from '@/server/household-format';
import { loadLookups } from '@/server/lookups';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('transferPlan'))('title') };
}

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  const [session, query, t, budgetT, locale] = await Promise.all([
    requireMember(h),
    searchParams,
    getTranslations('transferPlan'),
    getTranslations('budget'),
    getLocale(),
  ]);
  const ctx = toServiceCtx(session);
  const canWrite = session.role !== 'viewer';
  const resolved = await resolveBudget(ctx, query);
  const { timeZone } = await loadHouseholdFormat(ctx);
  const todayMonth = monthStart(todayIn(timeZone));

  if (resolved.kind === 'none') {
    return (
      <PageContainer>
        <PageHeader title={budgetT('title')} />
        <NoBudget variant="none" canWrite={canWrite} />
      </PageContainer>
    );
  }
  if (resolved.kind === 'uncovered') {
    const settings = await getHouseholdSettings(h);
    const start = budgetStartFor(resolved.month, settings.fiscalYearStartMonth);
    const nearest = nearestCoveredMonth(resolved.budgets, resolved.month);
    return (
      <PageContainer>
        <PageHeader
          title={budgetT('title')}
          tabs={
            <BudgetNav
              month={monthParam(resolved.month)}
              trailing={
                <PeriodStepper
                  inline
                  month={resolved.month}
                  todayMonth={todayMonth}
                  basePath="/budget/transfers"
                />
              }
            />
          }
        />
        <NoBudget
          variant="uncovered"
          canWrite={canWrite}
          monthLabel={formatMonth(resolved.month, locale)}
          createHref={`/budget/new?start=${monthParam(start)}`}
          rangeLabel={formatBudgetRange(start, locale)}
          nearest={
            nearest
              ? {
                  href: `/budget/transfers?month=${monthParam(nearest)}`,
                  label: formatMonth(nearest, locale),
                }
              : null
          }
        />
      </PageContainer>
    );
  }

  const { budget, month, monthIndex } = resolved;
  const pinnedId = resolved.pinned ? budget.id : undefined;
  const [view, plan, lookups] = await Promise.all([
    budgetMonthView(ctx, budget.id, monthIndex),
    transferPlan(ctx, budget.id, monthIndex),
    loadLookups(ctx),
  ]);

  const header = (
    <>
      <PageHeader
        title={budgetT('title')}
        description={budget.name}
        tabs={
          <BudgetNav
            month={monthParam(month)}
            start={monthParam(budget.startMonth)}
            {...(pinnedId ? { budgetId: pinnedId } : {})}
            trailing={
              <PeriodStepper
                inline
                month={month}
                todayMonth={todayMonth}
                basePath="/budget/transfers"
                {...(pinnedId ? { budgetId: pinnedId } : {})}
                {...(resolved.pinned ? { min: budget.startMonth, max: lastMonth(budget) } : {})}
              />
            }
          />
        }
      />
      {budget.status === 'archived' ? (
        <ArchivedNotice budgetId={budget.id} canWrite={canWrite} className="mb-4" />
      ) : null}
    </>
  );

  if (view.lines.length === 0) {
    return (
      <PageContainer>
        {header}
        <EmptyState
          title={t('noLinesTitle')}
          action={
            canWrite ? (
              <Link href="/budget/lines/new" className={buttonVariants({})}>
                {budgetT('addLine')}
              </Link>
            ) : undefined
          }
        >
          {t('noLinesBody')}
        </EmptyState>
      </PageContainer>
    );
  }

  if (!plan.configured) {
    return (
      <PageContainer>
        {header}
        <EmptyState
          title={t('noHubTitle')}
          action={
            session.role === 'owner' ? (
              <Link href="/settings/budget#hub" className={buttonVariants({})}>
                {t('noHubAction')}
              </Link>
            ) : undefined
          }
        >
          {session.role === 'owner' ? t('noHubBody') : `${t('noHubBody')} ${t('noHubAsk')}`}
        </EmptyState>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}
      <TransferPlanView
        plan={plan}
        lines={view.lines}
        accounts={lookups.accounts}
        month={month}
        {...(pinnedId ? { budgetId: pinnedId } : {})}
      />
    </PageContainer>
  );
}
