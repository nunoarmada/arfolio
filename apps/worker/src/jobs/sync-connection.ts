import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import {
  NotFoundError,
  syncConnection,
  type ConnectorDeps,
  type SyncDeps,
} from '@arfolio/services';
import { registerJob } from '../boss.js';
import { errorMessage, log } from '../log.js';
import { QUEUES, SYNC_QUEUE_OPTIONS } from '../queues.js';

const payload = z.strictObject({
  householdId: z.string().min(1),
  connectionId: z.string().min(1),
  trigger: z.enum(['scheduled', 'initial']),
});

/**
 * Runs one sync. Provider failures are part of the outcome (recorded on the sync run and the
 * connection), so they resolve. Unexpected errors, such as the database being down, reject and
 * fail the job. Jobs are sent with `retryLimit: 0`, so pg-boss does not retry them: claiming a
 * run already moved `next_sync_at`, and the next slot picks the connection up again (a repeat
 * is safe because ingest is idempotent).
 */
export async function runSyncConnectionJob(
  deps: SyncDeps,
  data: unknown,
  /** Called with the household after a successful or partial sync (queues AI categorisation). */
  afterSync?: (householdId: string) => Promise<void>,
  /**
   * Called after every sync that ran (success, partial or failed: a failure creates `sync_failing`)
   * and before an unexpected error is rethrown, to queue push delivery. Must not throw.
   */
  afterNotify?: () => Promise<void>,
  /** Called with the household and connection after a successful or partial sync (queues the Trading 212 merchant lookup). */
  afterConnectionSync?: (householdId: string, connectionId: string) => Promise<void>,
): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid sync job payload');
  const { householdId, connectionId, trigger } = parsed.data;
  try {
    const result = await syncConnection(deps, { householdId, connectionId, trigger });
    if (result.status !== 'skipped') await afterNotify?.();
    if (result.status === 'skipped') {
      log.info(`sync ${connectionId} skipped (${result.reason})`);
    } else if (result.status === 'success') {
      log.info(`sync ${connectionId} ok (inserted ${result.inserted})`);
    } else {
      log.warn(`sync ${connectionId} ${result.status} (${result.errorCode ?? 'unknown'})`);
    }
    if (afterSync && (result.status === 'success' || result.status === 'partial')) {
      // New rows may need categorising; failing to queue that must not fail the sync job.
      await afterSync(householdId).catch((err: unknown) =>
        log.warn(`sync ${connectionId}: could not queue AI categorisation: ${errorMessage(err)}`),
      );
    }
    if (afterConnectionSync && (result.status === 'success' || result.status === 'partial')) {
      await afterConnectionSync(householdId, connectionId).catch((err: unknown) =>
        log.warn(`sync ${connectionId}: could not queue follow-up work: ${errorMessage(err)}`),
      );
    }
  } catch (err) {
    // Removed after it was queued: nothing left to sync.
    if (err instanceof NotFoundError) {
      log.warn(`sync ${connectionId} dropped: connection no longer exists`);
      return;
    }
    await afterNotify?.();
    throw err;
  }
}

/**
 * Registers the sync job. The provider clients come from `getConnectors`, called at each job, so
 * Enable Banking credentials saved later take effect without a restart.
 */
export async function registerSyncConnection(
  boss: PgBoss,
  db: Db,
  getConnectors: () => Promise<ConnectorDeps>,
  afterSync?: (householdId: string) => Promise<void>,
  afterNotify?: () => Promise<void>,
  afterConnectionSync?: (householdId: string, connectionId: string) => Promise<void>,
): Promise<void> {
  await registerJob(
    boss,
    QUEUES.syncConnection,
    async (job) =>
      runSyncConnectionJob(
        { ...(await getConnectors()), db },
        job.data,
        afterSync,
        afterNotify,
        afterConnectionSync,
      ),
    {},
    SYNC_QUEUE_OPTIONS,
  );
}
