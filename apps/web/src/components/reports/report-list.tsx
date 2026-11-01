import { TriangleAlert } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';
import type { ServiceCtx } from '@arfolio/services';
import { formatMonth, formatShortDay } from '@/lib/dates';
import {
  loadLiveAnomalyCount,
  type ReportListData,
  type ReportRowDto,
  type ReportsContext,
} from '@/server/reports-data';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { ReportStatusBadge } from './status-badge';

/** The anomaly count of a month, in words. */
async function CountText({ count }: { count: number }) {
  const t = await getTranslations('reports.list');
  return (
    <span className="inline-flex items-center gap-1">
      {count > 0 ? (
        <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
      ) : null}
      {t('anomalies', { count })}
    </span>
  );
}

/** A count computed now from the movements (a recent month with no stored figures). */
async function LiveCount({ ctx, month }: { ctx: ServiceCtx; month: string }) {
  const [count, t] = await Promise.all([
    loadLiveAnomalyCount(ctx, month),
    getTranslations('reports.list'),
  ]);
  if (count === null) {
    return (
      <span>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('anomaliesUnavailable')}</span>
      </span>
    );
  }
  return <CountText count={count} />;
}

async function Row({
  row,
  ctx,
  rc,
  settling,
}: {
  row: ReportRowDto;
  ctx: ServiceCtx;
  rc: ReportsContext;
  /** A report is pending and the page refreshes itself: live counts wait until it stops. */
  settling: boolean;
}) {
  const [t, list] = await Promise.all([
    getTranslations('reports'),
    getTranslations('reports.list'),
  ]);
  const monthLabel = formatMonth(`${row.month}-01`, rc.locale);
  const sentence =
    row.status === 'ready'
      ? null
      : t(`row.${row.status}` as 'row.pending' | 'row.failed' | 'row.skipped' | 'row.none');
  return (
    <Card as="li" variant="interactive" pad="none">
      <Link
        href={`/insights/reports/${row.month}`}
        data-testid="report-row"
        data-month={row.month}
        data-status={row.status}
        className="grid min-h-[96px] grid-cols-1 content-start gap-1.5 rounded-[inherit] p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:p-5"
      >
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 wrap-anywhere text-card-title">
            {monthLabel}
            {row.status === 'ready' ? <span className="sr-only"> {list('readySr')}</span> : null}
          </span>
          {row.status !== 'ready' ? <ReportStatusBadge status={row.status} /> : null}
        </span>
        {row.status === 'ready' ? (
          <span className="line-clamp-2 wrap-anywhere text-sm text-foreground">
            {row.headline ?? ''}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{sentence}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums text-muted-foreground">
          {row.anomalyCount !== null ? (
            <CountText count={row.anomalyCount} />
          ) : row.live && !settling ? (
            <Suspense fallback={<Skeleton className="inline-block h-4 w-16 align-middle" />}>
              <LiveCount ctx={ctx} month={row.month} />
            </Suspense>
          ) : null}
          {row.generatedOn ? (
            <span>{list('generatedOn', { date: formatShortDay(row.generatedOn, rc.locale) })}</span>
          ) : null}
        </span>
      </Link>
    </Card>
  );
}

/** One grouped list of months, newest first, each a single link into the report. */
export async function ReportList({
  data,
  ctx,
  rc,
}: {
  data: ReportListData;
  ctx: ServiceCtx;
  rc: ReportsContext;
}) {
  const list = await getTranslations('reports.list');
  return (
    <>
      <ul
        data-testid="report-list"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 xl:gap-4"
      >
        {data.rows.map((row) => (
          <Row key={row.month} row={row} ctx={ctx} rc={rc} settling={data.anyPending} />
        ))}
      </ul>
      {data.isOlderPage ? (
        <Link
          href="/insights/reports"
          className="inline-flex min-h-11 w-fit items-center text-base font-medium text-primary-text underline-offset-4 hover:underline"
        >
          {list('newer')}
        </Link>
      ) : null}
      {data.nextBefore ? (
        <Link
          href={`/insights/reports?before=${data.nextBefore}`}
          className="inline-flex min-h-11 w-fit items-center text-base font-medium text-primary-text underline-offset-4 hover:underline"
        >
          {list('more')}
        </Link>
      ) : null}
    </>
  );
}
