import { budgetStartFor } from '@arfolio/core';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { BudgetNewForm } from '@/components/budget/budget-new-form';
import { PageHeader } from '@/components/page-header';
import { formatBudgetRange, nextStart, parseMonthParam } from '@/lib/budget-period';
import { todayIn } from '@/lib/dates';
import { toBudgetDto } from '@/server/budget-data';
import { getHouseholdSettings } from '@/server/household';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { listBudgets } from '@arfolio/services';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetNew'))('title') };
}

export default async function NewBudgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  const [session, query, t, locale] = await Promise.all([
    requireMember(h, { roles: ['owner', 'member'] }),
    searchParams,
    getTranslations('budgetNew'),
    getLocale(),
  ]);
  const ctx = toServiceCtx(session);
  const [settings, rows] = await Promise.all([getHouseholdSettings(h), listBudgets(ctx)]);
  const budgets = rows.map(toBudgetDto);
  const current = budgetStartFor(todayIn(settings.timezone), settings.fiscalYearStartMonth);
  const requested = parseMonthParam(Array.isArray(query.start) ? query.start[0] : query.start);
  const starts = [
    ...new Set([current, nextStart({ startMonth: current }), ...(requested ? [requested] : [])]),
  ].sort();
  const taken = new Set(budgets.map((b) => b.startMonth));
  const initialStart =
    (requested && starts.includes(requested) ? requested : undefined) ??
    starts.find((s) => !taken.has(s)) ??
    starts[0]!;
  return (
    <PageContainer width="narrow">
      <PageHeader title={t('title')} backHref="/budget" backLabel={t('back')} />
      <BudgetNewForm
        budgets={budgets}
        options={starts.map((start) => ({ start, label: formatBudgetRange(start, locale) }))}
        initialStart={initialStart}
      />
    </PageContainer>
  );
}
