import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { BlockSkeleton } from '@/components/home/block-frame';
import { InsightsNav } from '@/components/insights/insights-nav';
import { InsightsControls } from '@/components/insights/insights-controls';
import {
  CashFlowBlock,
  KpisBlock,
  SpendingBlock,
  TrendsBlock,
} from '@/components/insights/insights-blocks';
import { PageHeader } from '@/components/page-header';
import { monthStart, todayIn } from '@/lib/dates';
import { insightsHref, insightsRange, parseInsightsParams } from '@/lib/insights-chart';
import { periodWords } from '@/lib/insights-format';
import { loadHouseholdFormat } from '@/server/household-format';
import {
  loadInsightsCashFlow,
  loadInsightsSpending,
  loadInsightsTrends,
} from '@/server/insights-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('insights'))('title') };
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Análises: where the money goes (spending by group), what came in and went out (cash flow) and
 * how it moves over twelve months (trends). The period lives in the URL; every section loads in
 * its own Suspense boundary and fails on its own. Everything is read-only, so viewers see it all.
 *
 * This page is "Gráficos"; `InsightsNav` ("Gráficos · Relatórios") links to the monthly reports.
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, raw, t, common] = await Promise.all([
    requireMember(await headers()),
    searchParams,
    getTranslations('insights'),
    getTranslations('common'),
  ]);
  const ctx = toServiceCtx(session);
  const format = await loadHouseholdFormat(ctx);
  const currentMonth = monthStart(todayIn(format.timeZone));
  const params = parseInsightsParams(
    { range: first(raw.range), end: first(raw.end), account: first(raw.account) },
    currentMonth,
  );
  const { from, to, months } = insightsRange(params.range, params.end);
  const retryHref = insightsHref(params, currentMonth);

  // The three sections start together; none of the loaders rejects.
  const spending = loadInsightsSpending(ctx, { from, to });
  const cashFlow = loadInsightsCashFlow(ctx, { from, to }, params.account);
  const trends = loadInsightsTrends(ctx, params.end);

  return (
    <PageContainer className="grid grid-cols-1 gap-4 xl:gap-6 [&>header]:mb-0">
      <PageHeader title={t('title')} tabs={<InsightsNav current="charts" />} />
      <InsightsControls params={params} currentMonth={currentMonth} />
      <p className="text-sm text-muted-foreground">{t('basis')}</p>
      <Suspense fallback={<BlockSkeleton className="h-[120px]" />}>
        <KpisBlock result={trends} months={months} currentMonth={currentMonth} />
      </Suspense>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 xl:gap-6">
        <div className="min-w-0 lg:col-span-7 [&>*]:h-full">
          <Suspense fallback={<BlockSkeleton className="h-[400px]" status={common('loading')} />}>
            <SpendingBlock
              result={spending}
              from={from}
              to={to}
              words={periodWords(months, currentMonth, format.locale)}
              retryHref={retryHref}
            />
          </Suspense>
        </div>
        <div className="min-w-0 lg:col-span-5 [&>*]:h-full">
          <Suspense fallback={<BlockSkeleton className="h-[220px]" />}>
            <CashFlowBlock
              result={cashFlow}
              params={params}
              from={from}
              to={to}
              currentMonth={currentMonth}
              retryHref={retryHref}
            />
          </Suspense>
        </div>
        <div className="min-w-0 lg:col-span-12">
          <Suspense fallback={<BlockSkeleton className="h-[360px]" />}>
            <TrendsBlock
              result={trends}
              selected={months}
              currentMonth={currentMonth}
              retryHref={retryHref}
            />
          </Suspense>
        </div>
      </div>
    </PageContainer>
  );
}
