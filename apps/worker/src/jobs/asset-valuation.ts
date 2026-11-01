import type { PgBoss } from 'pg-boss';
import type { Db } from '@arfolio/db';
import {
  claimDueAssetValuations,
  DEFAULT_VALUATION_PORTALS,
  estimateAssetValue,
  markAssetValuationFailed,
  type AnthropicCreateLike,
  type AssetEstimateResult,
  type ValuationPortals,
} from '@arfolio/services';
import { createAiGate, modelOf } from '../ai-gate.js';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { AiRegisterDeps } from './ai-categorise.js';

/** Every 15 minutes: assets due for their monthly AI estimate, and requests, are picked up. */
export const ASSET_VALUATION_CRON = '*/15 * * * *';
/**
 * Assets estimated per run. Each estimate may search the web and continue a few times, so the
 * batch stays small; the next run takes the rest.
 */
export const ASSET_VALUATION_BATCH = 3;
/** Per request: a turn with web searches and fetches can take minutes. */
export const ASSET_VALUATION_REQUEST_TIMEOUT_MS = 600_000;
/** A run may take a full request timeout per asset (plus margin) before pg-boss expires it. */
export const ASSET_VALUATION_EXPIRE_SECONDS =
  (ASSET_VALUATION_BATCH * ASSET_VALUATION_REQUEST_TIMEOUT_MS) / 1000 + 15 * 60;

export type AssetValuationJobDeps = {
  db: Db;
  anthropic: AnthropicCreateLike | null;
  model: string;
  portals: ValuationPortals;
};

const errorClass = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

/**
 * One sweep: claims the assets due for an estimate (`claimDueAssetValuations` stamps them, so two
 * sweeps never take the same one) and estimates them one by one. Counts only are logged.
 */
export async function runAssetValuationSweep(
  deps: AssetValuationJobDeps & { anthropic: AnthropicCreateLike },
  tz: string,
  now: Date = new Date(),
): Promise<Record<AssetEstimateResult, number>> {
  const counts: Record<AssetEstimateResult, number> = {
    ready: 0,
    insufficient_data: 0,
    no_answer: 0,
    api_error: 0,
  };
  const rows = await claimDueAssetValuations(deps.db, {
    now,
    limit: ASSET_VALUATION_BATCH,
    tz,
    logger: log,
  });
  for (const row of rows) {
    try {
      const result = await estimateAssetValue({ ...deps, logger: log, now, tz }, row);
      counts[result] += 1;
    } catch (err) {
      // One asset failing must not stop the batch. The error class only: never its message.
      log.warn(`ai valuation failed unexpectedly (${errorClass(err)})`);
      counts.api_error += 1;
      try {
        await markAssetValuationFailed(deps.db, row, 'api_error');
      } catch (markErr) {
        log.warn(`ai valuation: marking the failure failed too (${errorClass(markErr)})`);
      }
    }
  }
  if (rows.length > 0) {
    log.info(
      `ai valuations: ${counts.ready} ready, ${counts.insufficient_data} without enough data, ${counts.no_answer} without an answer, ${counts.api_error} failed`,
    );
  }
  return counts;
}

/**
 * Registers the valuation sweep and its 15 minute schedule. The key, model and listing portals
 * are read at each run, so changes saved later take effect without a restart; while there is no
 * key the sweep does nothing (that is logged once per stretch).
 */
export async function registerAssetValuation(
  boss: PgBoss,
  deps: AiRegisterDeps<AnthropicCreateLike>,
  tz: string,
): Promise<void> {
  const open = createAiGate('AI asset valuation', deps.getConfig, deps.getAnthropic);
  await registerJob(
    boss,
    QUEUES.assetValuation,
    async () => {
      const ai = await open();
      if (!ai) return;
      const { cfg } = ai;
      await runAssetValuationSweep(
        {
          db: deps.db,
          anthropic: ai.anthropic,
          model: modelOf(cfg.models.valuation),
          portals: cfg.valuationPortals.value ?? DEFAULT_VALUATION_PORTALS,
        },
        tz,
      );
    },
    {},
    { expireInSeconds: ASSET_VALUATION_EXPIRE_SECONDS },
  );
  await boss.schedule(QUEUES.assetValuation, ASSET_VALUATION_CRON, null, { tz });
}
