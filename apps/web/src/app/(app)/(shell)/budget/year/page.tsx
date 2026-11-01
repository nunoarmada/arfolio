import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ArchivedNotice } from '@/components/budget/archived-notice';
import { BudgetNav } from '@/components/budget/budget-nav';
import { NoBudget } from '@/components/budget/no-budget';
import { YearActions } from '@/components/budget/year-actions';
import { YearGrid } from '@/components/budget/year-grid';
import { PageHeader } from '@/components/page-header';
import { parseShow } from '@/lib/budget-grid';
import { monthParam } from '@/lib/budget-period';
import { cn } from '@/lib/cn';
import { loadYearPage, resolveYearBudget } from '@/server/budget-data';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('budgetYear');
  return { title: t('title') };
}

export default async function BudgetYearPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, query, t, budgetT] = await Promise.all([
    requireMember(await headers()),
    searchParams,
    getTranslations('budgetYear'),
    getTranslations('budget'),
  ]);
  const ctx = toServiceCtx(session);
  const canWrite = session.role !== 'viewer';
  const resolved = await resolveYearBudget(ctx, query);
  if (resolved.kind === 'none') {
    return (
      <PageContainer width="full">
        <PageHeader title={budgetT('title')} />
        <NoBudget variant="none" canWrite={canWrite} />
      </PageContainer>
    );
  }
  const { budget, budgets, todayMonth } = resolved;
  const data = await loadYearPage(ctx, budget.id);
  const show = parseShow(Array.isArray(query.show) ? query.show[0] : query.show);
  const start = monthParam(budget.startMonth);

  // Previous and next among the budgets that exist (active ones, plus the one in view).
  const listed = budgets
    .filter((b) => b.status === 'active' || b.id === budget.id)
    .sort((a, b) => a.startMonth.localeCompare(b.startMonth));
  const at = listed.findIndex((b) => b.id === budget.id);
  const prev = listed[at - 1];
  const next = listed[at + 1];
  const arrow =
    'flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2 md:pointer-fine:size-9';
  const stepper = (target: (typeof listed)[number] | undefined, dir: 'prev' | 'next') => {
    const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
    if (!target) {
      return (
        <button
          type="button"
          aria-disabled="true"
          title={t(dir === 'prev' ? 'noPrevious' : 'noNext')}
          aria-label={t(dir === 'prev' ? 'noPrevious' : 'noNext')}
          className={cn(arrow, 'cursor-not-allowed text-subtle-foreground hover:bg-transparent')}
        >
          <Icon className="size-6" aria-hidden="true" />
        </button>
      );
    }
    return (
      <Link
        href={`/budget/year?start=${monthParam(target.startMonth)}&show=${show}`}
        aria-label={t(dir === 'prev' ? 'previous' : 'next', { name: target.name })}
        className={arrow}
      >
        <Icon className="size-6" aria-hidden="true" />
      </Link>
    );
  };

  const backBase = `/budget/year?start=${start}`;
  const addLine = `/budget/lines/new?${new URLSearchParams({
    budget: budget.id,
    kind: 'expense',
    back: `${backBase}&show=${show}`,
  }).toString()}`;

  const leading = (
    <div className="flex items-center">
      {stepper(prev, 'prev')}
      <span
        aria-live="polite"
        className="min-w-24 px-1 text-center text-base font-semibold md:text-sm"
        data-testid="budget-label"
      >
        {budget.name}
      </span>
      {stepper(next, 'next')}
    </div>
  );
  const trailing = <YearActions canWrite={canWrite} addLineHref={addLine} />;

  return (
    <PageContainer width="full">
      <PageHeader
        title={budgetT('title')}
        description={budget.name}
        tabs={
          <BudgetNav
            start={start}
            {...(resolved.pinned && budget.status === 'archived' ? { budgetId: budget.id } : {})}
          />
        }
      />
      {budget.status === 'archived' ? (
        <ArchivedNotice budgetId={budget.id} canWrite={canWrite} className="mb-4" />
      ) : null}
      {data.view.lines.length === 0 ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            {leading}
            <div className="ml-auto">{trailing}</div>
          </div>
          <NoBudget variant="noLines" canWrite={canWrite} />
        </>
      ) : (
        <YearGrid
          key={`${budget.id}`}
          budget={budget}
          view={data.view}
          lookups={data.lookups}
          show={show}
          todayMonth={todayMonth}
          canWrite={canWrite}
          backBase={backBase}
          leading={leading}
          trailing={trailing}
        />
      )}
    </PageContainer>
  );
}
