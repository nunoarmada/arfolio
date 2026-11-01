import { Plus } from 'lucide-react';
import { budgetStartFor } from '@arfolio/core';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArchivedNotice } from '@/components/budget/archived-notice';
import { BudgetNav } from '@/components/budget/budget-nav';
import { MonthView, type EndHint } from '@/components/budget/month-view';
import { NoBudget } from '@/components/budget/no-budget';
import { PeriodStepper } from '@/components/budget/period-stepper';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import {
  formatBudgetRange,
  lastMonth,
  monthIndexIn,
  monthParam,
  nearestCoveredMonth,
  nextStart,
} from '@/lib/budget-period';
import { formatMonth, monthStart, todayIn } from '@/lib/dates';
import { loadMonthPage, resolveBudget } from '@/server/budget-data';
import { getHouseholdSettings } from '@/server/household';
import { loadHouseholdFormat } from '@/server/household-format';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budget'))('title') };
}

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  const [session, query, t, locale] = await Promise.all([
    requireMember(h),
    searchParams,
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
        <PageHeader title={t('title')} />
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
          title={t('title')}
          tabs={
            <BudgetNav
              month={monthParam(resolved.month)}
              trailing={
                <PeriodStepper
                  inline
                  month={resolved.month}
                  todayMonth={todayMonth}
                  basePath="/budget"
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
                  href: `/budget?month=${monthParam(nearest)}`,
                  label: formatMonth(nearest, locale),
                }
              : null
          }
        />
      </PageContainer>
    );
  }

  const { budget, month, state } = resolved;
  const data = await loadMonthPage(ctx, resolved);
  const pinnedId = resolved.pinned ? budget.id : undefined;
  const hasNext = resolved.budgets.some(
    (b) => b.status === 'active' && b.startMonth === nextStart(budget),
  );
  const todayIndex = monthIndexIn(budget, todayMonth) ?? 0;
  const endHint: EndHint | null =
    canWrite &&
    budget.status === 'active' &&
    !hasNext &&
    (resolved.monthIndex === 12 || todayIndex >= 11)
      ? { endMonth: lastMonth(budget), nextStart: nextStart(budget) }
      : null;
  const addLineHref = `/budget/lines/new?${new URLSearchParams({
    budget: budget.id,
    kind: 'expense',
    back: `/budget?month=${monthParam(month)}${pinnedId ? `&budget=${pinnedId}` : ''}`,
  }).toString()}`;

  return (
    <PageContainer>
      <PageHeader
        title={t('title')}
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
                basePath="/budget"
                {...(pinnedId ? { budgetId: pinnedId } : {})}
                {...(resolved.pinned ? { min: budget.startMonth, max: lastMonth(budget) } : {})}
              />
            }
          />
        }
        actions={
          canWrite ? (
            <Link href={addLineHref} className={buttonVariants({ variant: 'outline' })}>
              <Plus className="size-4" aria-hidden="true" />
              {t('addLine')}
            </Link>
          ) : undefined
        }
      />
      {budget.status === 'archived' ? (
        <ArchivedNotice budgetId={budget.id} canWrite={canWrite} className="mb-4" />
      ) : null}
      {data.lines.length === 0 ? (
        <NoBudget variant="noLines" canWrite={canWrite} />
      ) : (
        <MonthView
          budget={budget}
          month={month}
          state={state}
          data={data}
          pinned={resolved.pinned}
          canWrite={canWrite}
          endHint={endHint}
        />
      )}
    </PageContainer>
  );
}
