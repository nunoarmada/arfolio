import type { PgBoss } from 'pg-boss';
import type { Db } from '@arfolio/db';
import {
  claimPendingReports,
  ensureMonthlyReports,
  generateReport,
  type AnthropicLike,
  type GenerateReportResult,
} from '@arfolio/services';
import { createAiGate, modelOf } from '../ai-gate.js';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { AiRegisterDeps } from './ai-categorise.js';

/** Every 5 minutes: new monthly reports are queued, and requests and retries picked up. */
export const AI_REPORT_CRON = '*/5 * * * *';
/**
 * Reports generated per run. At the 120 s request timeout this stays well inside the job's
 * expiry; the next run takes the rest.
 */
export const AI_REPORT_BATCH = 5;

export type AiReportJobDeps = { db: Db; anthropic: AnthropicLike | null; model: string };

/**
 * One sweep: queues the monthly report of every household whose month has closed, then claims
 * the due pending rows (new, requested or retrying) and generates them one by one. Two sweeps at
 * once never take the same row (`claimPendingReports`). Counts only are logged.
 */
export async function runAiReportSweep(
  deps: AiReportJobDeps & { anthropic: AnthropicLike },
  /** Called when a report became ready (queues push delivery for its notification). */
  afterNotify: () => Promise<void>,
  now: Date = new Date(),
): Promise<Record<GenerateReportResult, number>> {
  const counts: Record<GenerateReportResult, number> = {
    ready: 0,
    skipped: 0,
    retry: 0,
    failed: 0,
    superseded: 0,
  };
  await ensureMonthlyReports(deps.db, { now, logger: log });
  const rows = await claimPendingReports(deps.db, {
    now,
    limit: AI_REPORT_BATCH,
    logger: log,
  });
  for (const row of rows) {
    const result = await generateReport({ ...deps, logger: log, now }, row);
    counts[result] += 1;
  }
  if (rows.length > 0) {
    log.info(
      `ai reports: ${counts.ready} ready, ${counts.skipped} skipped, ${counts.retry} to retry, ${counts.failed} failed, ${counts.superseded} superseded`,
    );
  }
  if (counts.ready > 0) await afterNotify();
  return counts;
}

/**
 * Registers the report sweep and its 5 minute schedule. The key and model are read at each run,
 * so a key saved later takes effect without a restart; while there is no key the sweep does
 * nothing (that is logged once per stretch).
 */
export async function registerAiReport(
  boss: PgBoss,
  deps: AiRegisterDeps,
  tz: string,
  afterNotify: () => Promise<void> = async () => {},
): Promise<void> {
  const open = createAiGate('AI reports', deps.getConfig, deps.getAnthropic);
  await registerJob(boss, QUEUES.aiReport, async () => {
    const ai = await open();
    if (!ai) return;
    await runAiReportSweep(
      { db: deps.db, anthropic: ai.anthropic, model: modelOf(ai.cfg.models.report) },
      afterNotify,
    );
  });
  await boss.schedule(QUEUES.aiReport, AI_REPORT_CRON, null, { tz });
}
