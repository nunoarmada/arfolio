import type { PgBoss } from 'pg-boss';
import type { Db } from '@arfolio/db';
import { notifyExpiringConsents } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';

export const CONSENT_CHECK_CRON = '23 7 * * *';

export async function runConsentCheck(
  db: Db,
  now: Date = new Date(),
): Promise<{ expiring: number; expired: number }> {
  const totals = await notifyExpiringConsents(db, { now });
  if (totals.expiring + totals.expired > 0) {
    log.info(`consent check: ${totals.expiring} expiring, ${totals.expired} expired`);
  }
  return totals;
}

export async function registerConsentCheck(
  boss: PgBoss,
  db: Db,
  tz: string,
  /** Called after each check (queues push delivery for the notifications it created). */
  afterNotify: () => Promise<void> = async () => {},
): Promise<void> {
  await registerJob(boss, QUEUES.consentCheck, async () => {
    await runConsentCheck(db);
    await afterNotify();
  });
  await boss.schedule(QUEUES.consentCheck, CONSENT_CHECK_CRON, null, { tz });
}
