import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import { findBudgetAlertHouseholds, runBudgetAlerts } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { SendWithOptions } from './recurring-detect.js';

/** Daily, after the morning sync window (06:00) and the recurring detection (07:30). */
export const BUDGET_ALERTS_CRON = '15 8 * * *';

const payload = z.strictObject({ householdId: z.string().min(1) });

/** Runs one alert pass for a household. Counts only are logged. */
export async function runBudgetAlertsJob(db: Db, data: unknown, now?: Date): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid budget-alerts job payload');
  const result = await runBudgetAlerts({ db, ...(now ? { now } : {}) }, parsed.data.householdId);
  if (result.lineAlerts + result.unallocatedAlerts > 0) {
    log.info(
      `budget alerts: ${result.lineAlerts} line threshold, ${result.unallocatedAlerts} unallocated`,
    );
  }
}

/**
 * Queues a pass for one household. The singleton key keeps at most one queued job per household
 * (the queue policy is `stately`). No retries: tomorrow's run repeats it.
 */
export async function enqueueBudgetAlerts(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(QUEUES.budgetAlerts, { householdId }, { singletonKey: householdId, retryLimit: 0 });
}

/** Queues a pass for every household. Returns how many. */
export async function enqueueBudgetAlertsAll(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findBudgetAlertHouseholds(db);
  for (const householdId of households) await enqueueBudgetAlerts(send, householdId);
  return households.length;
}

/** Registers the per-household job and the household-agnostic daily schedule that feeds it. */
export async function registerBudgetAlerts(
  boss: PgBoss,
  db: Db,
  tz: string,
  /** Called after each pass (queues push delivery for the notifications it created). */
  afterNotify: () => Promise<void> = async () => {},
): Promise<void> {
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await registerJob(
    boss,
    QUEUES.budgetAlerts,
    async (job) => {
      await runBudgetAlertsJob(db, job.data);
      await afterNotify();
    },
    {},
    { policy: 'stately' },
  );
  await registerJob(boss, QUEUES.budgetAlertsScheduler, async () => {
    await enqueueBudgetAlertsAll(db, send);
  });
  await boss.schedule(QUEUES.budgetAlertsScheduler, BUDGET_ALERTS_CRON, null, { tz });
}
