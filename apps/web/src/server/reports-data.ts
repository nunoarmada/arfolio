import {
  detectAnomalies,
  getReport,
  isAiAvailable,
  listReports,
  REPORT_MAX_REGENERATIONS,
  type ReportContent,
  type ServiceCtx,
} from '@arfolio/services';
export type { Money4, NumbersDto } from './reports-map';
import { todayIn } from '../lib/dates';
import {
  buildListRows,
  isRecentMonth,
  lastClosedMonth,
  LIST_PAGE_SIZE,
  toAnomalyDto,
  type AnomalyDto,
  type ListRow,
  type Role,
  type RowStatus,
} from '../lib/reports';
import { toNumbers, toStoredAnomalies, type NumbersDto } from './reports-map';
import { getIntegrationConfig } from './integration-config';
import { loadAiEnabled, loadHouseholdFormat } from './household-format';

/** What every Relatórios page needs to know about the viewer, the household and the installation. */
export interface ReportsContext {
  role: Role;
  /** The installation has an AI API key. */
  aiAvailable: boolean;
  /** The household switched AI on. */
  aiEnabled: boolean;
  locale: string;
  timeZone: string;
  currency: string;
  /** Today in the household time zone, `yyyy-mm-dd`. */
  today: string;
  /** The only month a report can be asked for, `yyyy-mm`. */
  lastClosed: string;
  maxRegenerations: number;
}

export async function loadReportsContext(ctx: ServiceCtx): Promise<ReportsContext> {
  const [format, aiEnabled] = await Promise.all([loadHouseholdFormat(ctx), loadAiEnabled(ctx)]);
  const today = todayIn(format.timeZone);
  return {
    role: ctx.role,
    aiAvailable: isAiAvailable(await getIntegrationConfig()),
    aiEnabled,
    locale: format.locale,
    timeZone: format.timeZone,
    currency: format.currency,
    today,
    lastClosed: lastClosedMonth(today),
    maxRegenerations: REPORT_MAX_REGENERATIONS,
  };
}

// ---------------------------------------------------------------------------------------------
// List

export interface ReportRowDto extends ListRow {
  headline: string | null;
  /** When the report was last written, as a household-local `yyyy-mm-dd`. */
  generatedOn: string | null;
  /** Stored anomaly count; null when it has to be computed live (see `live`) or is unknown. */
  anomalyCount: number | null;
  /** The count is computed now from the movements (recent months without stored facts). */
  live: boolean;
}

export interface ReportListData {
  rows: ReportRowDto[];
  /** Month to continue from (`?before=`), when there are older reports. */
  nextBefore: string | null;
  anyPending: boolean;
  /** This page starts after a month (`?before=`), so a way back to the newest is offered. */
  isOlderPage: boolean;
}

export async function loadReportList(
  ctx: ServiceCtx,
  rc: ReportsContext,
  before: string | null,
): Promise<ReportListData> {
  const fetched = await listReports(ctx, {
    limit: LIST_PAGE_SIZE + 1,
    ...(before ? { before } : {}),
  });
  const reports = fetched.slice(0, LIST_PAGE_SIZE);
  const byMonth = new Map(reports.map((r) => [r.month, r]));
  const rows = buildListRows(reports, rc.today, before === null).map((row): ReportRowDto => {
    const r = byMonth.get(row.month);
    const stored = r?.facts ? r.facts.anomalies.length : null;
    return {
      ...row,
      headline: r?.status === 'ready' ? (r.content?.headline ?? null) : null,
      generatedOn: r?.status === 'ready' ? todayIn(rc.timeZone, r.updatedAt) : null,
      anomalyCount: stored,
      live: stored === null && isRecentMonth(row.month, rc.today),
    };
  });
  return {
    rows,
    nextBefore: fetched.length > LIST_PAGE_SIZE ? reports.at(-1)!.month : null,
    anyPending: rows.some((r) => r.status === 'pending'),
    isOlderPage: before !== null,
  };
}

/** The live anomaly count of a month; null when it could not be computed (never rejects). */
export async function loadLiveAnomalyCount(ctx: ServiceCtx, month: string): Promise<number | null> {
  try {
    return (await detectAnomalies(ctx, { month })).length;
  } catch (error) {
    console.error(
      `reports anomaly count failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Detail

export interface ReportDetailDto {
  month: string;
  status: RowStatus;
  model: string | null;
  locale: string;
  content: ReportContent | null;
  errorCode: string | null;
  regenerations: number;
  /** ISO timestamp of the last write (when a ready report was generated). */
  updatedAt: string | null;
  numbers: NumbersDto | null;
  /** Stored anomalies (ready and skipped reports), already in minor units. */
  storedAnomalies: AnomalyDto[] | null;
}

/** The stored report of a month as plain data, or `{ status: 'none' }` when there is none. */
export async function loadReportDetail(ctx: ServiceCtx, month: string): Promise<ReportDetailDto> {
  const report = await getReport(ctx, { month });
  if (!report) {
    return {
      month,
      status: 'none',
      model: null,
      locale: '',
      content: null,
      errorCode: null,
      regenerations: 0,
      updatedAt: null,
      numbers: null,
      storedAnomalies: null,
    };
  }
  const finished = report.status === 'ready' || report.status === 'skipped';
  return {
    month,
    status: report.status,
    model: report.model,
    locale: report.locale,
    content: report.status === 'ready' ? report.content : null,
    errorCode: report.errorCode,
    regenerations: report.regenerations,
    updatedAt: report.updatedAt.toISOString(),
    // The numbers table belongs to a ready report; a skipped month has nothing to compare.
    numbers: report.status === 'ready' ? toNumbers(report.facts) : null,
    storedAnomalies: finished ? toStoredAnomalies(report.facts) : null,
  };
}

export type AnomaliesData =
  { kind: 'ready'; source: 'stored' | 'live'; items: AnomalyDto[] } | { kind: 'error' };

/** Stored anomalies when the report has them, else computed now from the movements. */
export async function loadAnomalies(
  ctx: ServiceCtx,
  currency: string,
  detail: ReportDetailDto,
): Promise<AnomaliesData> {
  if (detail.storedAnomalies) {
    return { kind: 'ready', source: 'stored', items: detail.storedAnomalies };
  }
  try {
    const items = await detectAnomalies(ctx, { month: detail.month });
    return { kind: 'ready', source: 'live', items: items.map((a) => toAnomalyDto(a, currency)) };
  } catch (error) {
    console.error(`reports anomalies failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return { kind: 'error' };
  }
}
