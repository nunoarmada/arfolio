import type { PgBoss } from 'pg-boss';
import { deliverPendingPush, vapidKeys, type PushSender, type VapidDeps } from '@arfolio/services';
import { registerJob } from '../boss.js';
import { errorMessage, log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { SendWithOptions } from './recurring-detect.js';

/** Every minute: the safety net for anything the notifying jobs did not queue a delivery for. */
export const PUSH_DELIVER_CRON = '* * * * *';

/** Notifications taken per household per run. */
const BATCH = 50;
const SINGLETON_KEY = 'push-deliver';

export type PushDeliverDeps = Pick<
  VapidDeps,
  'db' | 'encryptionKey' | 'publicKey' | 'privateKey' | 'subject' | 'appUrl'
> & {
  /** PUSH_ALLOWED_HOSTS. */
  allowedHosts: readonly string[] | undefined;
  /** The real `web-push` sender in production; tests inject a fake. */
  sender: PushSender;
};

/** One delivery pass. Counts only are logged: never endpoints, keys or notification content. */
export async function runPushDeliverJob(deps: PushDeliverDeps, now = new Date()): Promise<void> {
  const vapid = await vapidKeys(deps);
  const result = await deliverPendingPush(
    { db: deps.db, vapid, allowedHosts: deps.allowedHosts },
    { now, sender: deps.sender, batch: BATCH },
  );
  if (result.rejected > 0) {
    // Once per run, never per device: an endpoint is a capability URL and stays out of the logs.
    log.warn('push rejected (401/403): check the VAPID keys and subject');
  }
  if (result.invalid > 0) {
    // A web/worker PUSH_ALLOWED_HOSTS mismatch deletes devices; say so once per run, no endpoint.
    log.warn('endpoint not in the push allowlist (check PUSH_ALLOWED_HOSTS on the worker)');
  }
  if (result.claimed + result.expired + result.removed > 0) {
    log.info(
      `push delivery: ${result.claimed} notifications, ${result.sent} devices reached, ` +
        `${result.failed} failed, ${result.removed} devices removed, ${result.expired} too old`,
    );
  }
}

/**
 * Queues a delivery pass. The singleton key keeps one queued job (the queue is `stately`), so a
 * burst of notifying jobs costs one pass. No retries: the per-minute schedule is the retry.
 */
export async function enqueuePushDeliver(send: SendWithOptions): Promise<void> {
  await send(QUEUES.pushDeliver, {}, { singletonKey: SINGLETON_KEY, retryLimit: 0 });
}

/**
 * For the jobs that create notifications: ask for a prompt delivery. Failing to queue it must not
 * fail the job that did the real work, because the per-minute schedule delivers anyway.
 */
export async function queuePushDelivery(enqueue: () => Promise<void>): Promise<void> {
  await enqueue().catch((err: unknown) =>
    log.warn(`could not queue push delivery: ${errorMessage(err)}`),
  );
}

/** Registers the delivery job and its every-minute schedule. Returns the function to queue a pass. */
export async function registerPushDeliver(
  boss: PgBoss,
  deps: PushDeliverDeps,
  tz: string,
): Promise<() => Promise<void>> {
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await registerJob(
    boss,
    QUEUES.pushDeliver,
    async () => {
      await runPushDeliverJob(deps);
    },
    {},
    { policy: 'stately' },
  );
  await boss.schedule(QUEUES.pushDeliver, PUSH_DELIVER_CRON, null, { tz });
  return () => enqueuePushDeliver(send);
}
