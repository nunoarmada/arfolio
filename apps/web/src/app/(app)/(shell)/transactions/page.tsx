import { countAiAppliedSince, reviewCount } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { ReviewBanner } from '@/components/review-banner';
import { AddMenu } from '@/components/transactions/add-menu';
import { TransactionsView } from '@/components/transactions/transactions-view';
import { todayIn } from '@/lib/dates';
import { filtersToParams, parseFilters } from '@/lib/transaction-filters';
import { loadAiEnabled, loadHouseholdFormat } from '@/server/household-format';
import { loadLookups } from '@/server/lookups';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { loadRecentCategoryIds, loadTransactionsPage } from '@/server/transactions-data';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('transactions'))('title') };
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, raw, t] = await Promise.all([
    requireMember(await headers()),
    searchParams,
    getTranslations('transactions'),
  ]);
  const ctx = toServiceCtx(session);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, v);
    }
  }
  const filters = parseFilters(params);
  const query = filtersToParams(filters).toString();
  const [format, lookups, recentIds, count, initial, aiEnabled, aiApplied] = await Promise.all([
    loadHouseholdFormat(ctx),
    loadLookups(ctx),
    loadRecentCategoryIds(ctx),
    reviewCount(ctx),
    loadTransactionsPage(ctx, query, null),
    loadAiEnabled(ctx),
    countAiAppliedSince(ctx, 30),
  ]);

  return (
    <PageContainer width="full" className="grid grid-cols-1 gap-4 [&>header]:mb-0">
      <PageHeader
        title={t('title')}
        actions={session.role === 'viewer' ? undefined : <AddMenu />}
      />
      <ReviewBanner count={count} />
      <TransactionsView
        resetKey={query}
        initial={initial}
        filters={filters}
        today={todayIn(format.timeZone)}
        accounts={lookups.accounts}
        groups={lookups.groups}
        categories={lookups.categories}
        recentIds={recentIds}
        canWrite={session.role !== 'viewer'}
        basePath="/transactions"
        openManual={params.get('add') === 'manual'}
        showAiFilter={aiEnabled || aiApplied > 0}
      />
    </PageContainer>
  );
}
