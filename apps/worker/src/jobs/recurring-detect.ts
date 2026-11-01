import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import { findRecurringHouseholds, runRecurringDetection } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';

/** Daily, after the morning sync window. */
export const RECURRING_DETECT_CRON = '30 7 * * *';

const payload = z.strictObject({ householdId: z.string().min(1) });

export type SendWithOptions = (
  name: string,
  data: object,
  options: { singletonKey: string; retryLimit: number },
) => Promise<unknown>;

/** Runs one detection pass for a household. Counts only are logged. */
export async function runRecurringDetectJob(db: Db, data: unknown): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid recurring-detect job payload');
  const result = await runRecurringDetection({ db }, parsed.data.householdId);
  if (result.created + result.missed + result.priceChanges > 0) {
    log.info(
      `recurring detection: ${result.created} new, ${result.missed} missed, ${result.priceChanges} price changes`,
    );
  }
}

/**
 * Queues a pass for one household. The singleton key keeps at most one queued job per household
 * (the queue policy is `stately`: one queued and one active). No retries: tomorrow's run repeats it.
 */
export async function enqueueRecurringDetect(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(QUEUES.recurringDetect, { householdId }, { singletonKey: householdId, retryLimit: 0 });
}

/** Queues a pass for every household. Returns how many. */
export async function enqueueRecurringDetectAll(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findRecurringHouseholds(db);
  for (const householdId of households) await enqueueRecurringDetect(send, householdId);
  return households.length;
}

/** Registers the per-household job and the household-agnostic daily schedule that feeds it. */
export async function registerRecurringDetect(
  boss: PgBoss,
  db: Db,
  tz: string,
  /** Called after each pass (queues push delivery for the notifications it created). */
  afterNotify: () => Promise<void> = async () => {},
): Promise<void> {
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await registerJob(
    boss,
    QUEUES.recurringDetect,
    async (job) => {
      await runRecurringDetectJob(db, job.data);
      await afterNotify();
    },
    {},
    {
      policy: 'stately',
    },
  );
  await registerJob(boss, QUEUES.recurringScheduler, async () => {
    await enqueueRecurringDetectAll(db, send);
  });
  await boss.schedule(QUEUES.recurringScheduler, RECURRING_DETECT_CRON, null, { tz });
}
