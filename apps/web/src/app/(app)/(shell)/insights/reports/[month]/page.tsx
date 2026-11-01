import { ChevronLeft, CircleAlert } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { AiBlock } from '@/components/reports/ai-block';
import { AnomaliesSection, AnomaliesSkeleton } from '@/components/reports/anomalies-section';
import { NumbersSection } from '@/components/reports/numbers-section';
import { PendingPanel } from '@/components/reports/pending-poll';
import { ReportAction } from '@/components/reports/report-action';
import { AiStateCard, GenerateCard, StateCard } from '@/components/reports/state-cards';
import { ReportStatusBadge } from '@/components/reports/status-badge';
import { ReportStatusRegion } from '@/components/reports/status-region';
import { formatDateTime, formatMonth, monthStart } from '@/lib/dates';
import { insightsHref } from '@/lib/insights-chart';
import { actionState, isClosedMonth, isTooOld, type RowStatus } from '@/lib/reports';
import {
  loadAnomalies,
  loadReportDetail,
  loadReportsContext,
  type AnomaliesData,
  type ReportsContext,
} from '@/server/reports-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

type Params = Promise<{ month: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { month } = await params;
  const t = await getTranslations('reports.detail');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { title: t('back') };
  return { title: t('title', { month: formatMonth(`${month}-01`, await getLocale()) }) };
}

/** The anomalies, loaded in their own boundary so a slow or failing section never blocks the rest. */
async function AnomaliesBlock({
  promise,
  rc,
  month,
  monthLabel,
  storedAt,
}: {
  promise: Promise<AnomaliesData>;
  rc: ReportsContext;
  month: string;
  monthLabel: string;
  storedAt: string | null;
}) {
  return (
    <AnomaliesSection
      data={await promise}
      month={month}
      monthLabel={monthLabel}
      currency={rc.currency}
      locale={rc.locale}
      role={rc.role}
      storedAt={storedAt}
    />
  );
}

/**
 * One month: the AI text (when there is a report) in its own block, then the computed figures
 * (anomalies and the numbers), which come from the ledger and never from a model. A month with no
 * report still shows its anomalies, computed now. Pending reports show only the pending state.
 */
export default async function ReportPage({ params }: { params: Params }) {
  const [{ month }, session, t] = await Promise.all([
    params,
    requireMember(await headers()),
    getTranslations('reports'),
  ]);
  const ctx = toServiceCtx(session);
  const rc = await loadReportsContext(ctx);
  if (!isClosedMonth(month, rc.today)) notFound();
  const detail = await loadReportDetail(ctx, month);
  if (detail.status === 'none' && isTooOld(month, rc.today)) notFound();

  const monthLabel = formatMonth(`${month}-01`, rc.locale);
  // A "ready" row whose stored text no longer fits the schema is shown as a failure.
  const status: RowStatus = detail.status === 'ready' && !detail.content ? 'failed' : detail.status;
  const state = actionState({
    role: rc.role,
    aiAvailable: rc.aiAvailable,
    aiEnabled: rc.aiEnabled,
    month,
    lastClosed: rc.lastClosed,
    status,
    regenerations: detail.regenerations,
    maxRegenerations: rc.maxRegenerations,
  });
  const when = detail.updatedAt ? formatDateTime(detail.updatedAt, rc.locale, rc.timeZone) : null;
  const anomalies = loadAnomalies(ctx, rc.currency, detail);
  const isOwner = rc.role === 'owner';
  const action = (mode: 'regenerate' | 'again' | 'retry') =>
    state.allowed && !state.limitReached ? (
      <ReportAction
        month={month}
        monthLabel={monthLabel}
        mode={mode}
        left={state.left}
        max={rc.maxRegenerations}
        aiAvailable={rc.aiAvailable}
        isOwner={isOwner}
      />
    ) : state.limitReached && month === rc.lastClosed ? (
      <p className="text-sm text-muted-foreground">
        {t('limit.reached', { month: monthLabel, max: rc.maxRegenerations })}
      </p>
    ) : null;

  const framed = 'grid grid-cols-1 justify-items-start gap-3';

  return (
    <PageContainer>
      <Link
        href="/insights/reports"
        className="mb-2 hidden min-h-11 w-fit items-center gap-1 text-base text-primary-text underline-offset-4 hover:underline md:inline-flex"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {t('detail.back')}
      </Link>
      <PageHeader
        title={t('detail.title', { month: monthLabel })}
        backHref="/insights/reports"
        backLabel={t('detail.back')}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12 xl:gap-6">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4 xl:col-span-8 xl:row-start-1">
          <ReportStatusRegion
            status={status}
            messages={{
              pending: t('detail.pendingTitle', { month: monthLabel }),
              ready: t('live.ready', { month: monthLabel }),
              failed: t('live.failed', { month: monthLabel }),
            }}
          />
          {(status === 'ready' && when) || status === 'failed' || status === 'skipped' ? (
            <div className="text-sm text-muted-foreground">
              {status === 'ready' ? (
                <p>
                  {t('detail.generatedAt', { datetime: when ?? '' })}
                  {detail.regenerations > 0 ? ` · ${t('detail.regenerated')}` : ''}
                </p>
              ) : (
                <ReportStatusBadge status={status as 'failed' | 'skipped'} />
              )}
            </div>
          ) : null}

          {status === 'ready' && detail.content ? (
            <AiBlock
              content={detail.content}
              model={detail.model}
              datetime={when ?? ''}
              reportLocale={detail.locale}
              controls={
                action('regenerate') ??
                (!rc.aiEnabled ? (
                  <p className="text-sm text-muted-foreground">{t('aiOffNote')}</p>
                ) : null)
              }
            />
          ) : status === 'pending' ? (
            <PendingPanel month={monthLabel} />
          ) : status === 'failed' ? (
            <Card as="section" data-testid="report-failed" className={framed}>
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 size-5 shrink-0 text-negative" aria-hidden="true" />
                <h2 className="min-w-0 wrap-anywhere text-card-title">
                  {t('detail.failedTitle', { month: monthLabel })}
                </h2>
              </div>
              {detail.errorCode ? (
                <p className="break-all text-sm text-muted-foreground">
                  {t('detail.errorRef', { code: detail.errorCode })}
                </p>
              ) : null}
              {action('retry')}
            </Card>
          ) : status === 'skipped' ? (
            <Card as="section" data-testid="report-skipped" className={framed}>
              <h2 className="text-card-title">{t('detail.skippedTitle')}</h2>
              <p className="max-w-[68ch] text-base text-muted-foreground">
                {t('detail.skippedBody', { month: monthLabel })}
              </p>
              {action('again')}
            </Card>
          ) : !rc.aiAvailable || !rc.aiEnabled || month !== rc.lastClosed ? (
            <div className="grid grid-cols-1 gap-4">
              <StateCard
                testId="report-none"
                as="h2"
                title={t('detail.noReport.title', { month: monthLabel })}
              >
                {t('detail.noReport.body')}
              </StateCard>
              {!rc.aiAvailable || !rc.aiEnabled ? <AiStateCard rc={rc} as="h2" /> : null}
            </div>
          ) : (
            <GenerateCard month={month} monthLabel={monthLabel} rc={rc} as="h2" />
          )}
        </div>

        {/* The computed figures. On wide screens the anomalies sit in a side column beside the
            AI text and the numbers; below that the order is the reading order. */}
        <div className="min-w-0 xl:col-span-4 xl:col-start-9 xl:row-span-2 xl:row-start-1">
          <Suspense fallback={<AnomaliesSkeleton />}>
            <AnomaliesBlock
              promise={anomalies}
              rc={rc}
              month={month}
              monthLabel={monthLabel}
              storedAt={detail.storedAnomalies ? when : null}
            />
          </Suspense>
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-4 xl:col-span-8 xl:col-start-1 xl:row-start-2">
          {!detail.numbers ? (
            <Link
              href={insightsHref(
                { range: 1, end: `${month}-01`, account: null },
                monthStart(rc.today),
              )}
              className="inline-flex min-h-11 w-fit items-center text-base font-medium text-primary-text underline-offset-4 hover:underline"
            >
              {t('numbers.charts', { month: monthLabel })}
            </Link>
          ) : null}

          {detail.numbers ? (
            <NumbersSection
              data={detail.numbers}
              month={month}
              monthLabel={monthLabel}
              locale={rc.locale}
              currentMonth={monthStart(rc.today)}
            />
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
