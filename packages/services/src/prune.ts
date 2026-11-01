import { and, eq, lt, notExists } from 'drizzle-orm';
import { schema, withHousehold, type Db } from '@arfolio/db';

const { consentState, notification, oauthClient, oauthConsent, organization, syncRun } = schema;

const DAY_MS = 86_400_000;
/** A consent state lives 30 minutes; a day later nothing can still use it. */
const CONSENT_STATE_RETENTION_DAYS = 1;
const SYNC_RUN_RETENTION_DAYS = 180;
/** Test notifications are only ever pushed (never listed), and a push expires after 24 h. */
const PUSH_TEST_RETENTION_DAYS = 2;
/** Dynamic registration is open: a client nobody consented to within a week is just clutter. */
const OAUTH_ORPHAN_RETENTION_DAYS = 7;

/**
 * Housekeeping for rows that only matter briefly: consent states older than a day and sync runs
 * older than 180 days, and `push_test` notifications older than two days, and OAuth clients registered over a week ago that nobody consented to (the
 * oauth tables are global, not household-scoped). Runs over every household, each in its own
 * transaction (RLS needs one household at a time). Returns how many rows were deleted.
 */
export async function pruneSyncData(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ consentStates: number; syncRuns: number; pushTests: number; oauthClients: number }> {
  const now = opts.now ?? new Date();
  const consentCutoff = new Date(now.getTime() - CONSENT_STATE_RETENTION_DAYS * DAY_MS);
  const runCutoff = new Date(now.getTime() - SYNC_RUN_RETENTION_DAYS * DAY_MS);
  const pushTestCutoff = new Date(now.getTime() - PUSH_TEST_RETENTION_DAYS * DAY_MS);
  const households = await db.select({ id: organization.id }).from(organization);
  const totals = { consentStates: 0, syncRuns: 0, pushTests: 0, oauthClients: 0 };
  for (const { id: householdId } of households) {
    await withHousehold(db, householdId, async (tx) => {
      const states = await tx
        .delete(consentState)
        .where(
          and(eq(consentState.householdId, householdId), lt(consentState.createdAt, consentCutoff)),
        )
        .returning({ id: consentState.id });
      const runs = await tx
        .delete(syncRun)
        .where(and(eq(syncRun.householdId, householdId), lt(syncRun.startedAt, runCutoff)))
        .returning({ id: syncRun.id });
      const tests = await tx
        .delete(notification)
        .where(
          and(
            eq(notification.householdId, householdId),
            eq(notification.kind, 'push_test'),
            lt(notification.createdAt, pushTestCutoff),
          ),
        )
        .returning({ id: notification.id });
      totals.pushTests += tests.length;
      totals.consentStates += states.length;
      totals.syncRuns += runs.length;
    });
  }
  const orphanCutoff = new Date(now.getTime() - OAUTH_ORPHAN_RETENTION_DAYS * DAY_MS);
  const orphans = await db
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, orphanCutoff),
        notExists(
          db
            .select({ id: oauthConsent.id })
            .from(oauthConsent)
            .where(eq(oauthConsent.clientId, oauthClient.clientId)),
        ),
      ),
    )
    .returning({ id: oauthClient.id });
  totals.oauthClients = orphans.length;
  return totals;
}
