import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import { enrichMerchants, fetchMerchantLogos, findAiHouseholds } from '@arfolio/services';
import { createAiGate, modelOf } from '../ai-gate.js';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { AiJobDeps, AiRegisterDeps, SendWithOptions } from './ai-categorise.js';

/** Leftovers: rows past the per-run cap, failed batches, logos that could not be fetched. */
export const MERCHANT_SWEEP_CRON = '37 * * * *';

const payload = z.strictObject({ householdId: z.string().min(1) });

/** The categorisation deps plus the installation switch `MERCHANT_LOGOS`. */
export type MerchantJobDeps = AiJobDeps & { logos: boolean };
export type MerchantRegisterDeps = AiRegisterDeps & { logos: boolean };

/** Names the household's merchants, then fetches the logos of those with a website. Counts only are logged. */
export async function runMerchantEnrichJob(deps: MerchantJobDeps, data: unknown): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid merchant-enrich job payload');
  const { householdId } = parsed.data;
  await enrichMerchants(
    { db: deps.db, anthropic: deps.anthropic, model: deps.model, logger: log },
    { householdId },
  );
  await fetchMerchantLogos({ db: deps.db, enabled: deps.logos, logger: log }, { householdId });
}

/**
 * Queues a pass for one household. The singleton key keeps at most one queued job per household
 * (the queue policy is `stately`), so a burst of syncs collapses. No retries: the hourly sweep
 * picks up whatever a failed run left.
 */
export async function enqueueMerchantEnrich(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(QUEUES.merchantEnrich, { householdId }, { singletonKey: householdId, retryLimit: 0 });
}

/** Queues a pass for every household that has AI on. Returns how many. */
export async function enqueueMerchantSweep(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findAiHouseholds(db);
  for (const householdId of households) {
    await enqueueMerchantEnrich(send, householdId);
  }
  return households.length;
}

/**
 * Registers the merchant job and its hourly sweep, whether or not a key is configured: the key
 * and model are read at each run, so a key saved later takes effect without a restart. While
 * there is no key nothing is queued and queued jobs do nothing. Returns the function the sync job
 * calls after each sync.
 */
export async function registerMerchantEnrich(
  boss: PgBoss,
  deps: MerchantRegisterDeps,
  tz: string,
): Promise<(householdId: string) => Promise<void>> {
  const { db, logos } = deps;
  const open = createAiGate('merchant enrichment', deps.getConfig, deps.getAnthropic);
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await boss.createQueue(QUEUES.merchantEnrich, { policy: 'stately' });
  await registerJob(boss, QUEUES.merchantEnrich, async (job) => {
    const ai = await open();
    if (!ai) return;
    await runMerchantEnrichJob(
      { db, anthropic: ai.anthropic, model: modelOf(ai.cfg.models.categorisation), logos },
      job.data,
    );
  });
  await registerJob(boss, QUEUES.merchantSweep, async () => {
    if (!(await open())) return;
    await enqueueMerchantSweep(db, send);
  });
  await boss.schedule(QUEUES.merchantSweep, MERCHANT_SWEEP_CRON, null, { tz });
  return async (householdId) => {
    if (!(await open())) return;
    await enqueueMerchantEnrich(send, householdId);
  };
}
