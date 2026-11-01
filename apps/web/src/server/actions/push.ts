'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  findMyPushDevice,
  NotFoundError,
  sendTestPush,
  subscribePush,
  unsubscribePush,
  ValidationError,
} from '@arfolio/services';
import { getEnv } from '../../lib/env';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/settings/preferences');

async function ctx() {
  return getServiceCtx(await headers());
}

/** Shape check at the boundary; the service then validates the endpoint host and the key sizes. */
const subscriptionInput = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  userAgent: z.string().max(2048).optional(),
});

/** The browser's own subscription, stored for the caller. Viewers register their own devices too. */
export async function subscribePushAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const parsed = subscriptionInput.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    const result = await subscribePush(await ctx(), parsed.data, {
      allowedHosts: getEnv().PUSH_ALLOWED_HOSTS ?? [],
    });
    refresh();
    return result;
  });
}

const target = z.union([
  z.object({ id: z.uuid() }).strict(),
  z.object({ endpoint: z.string().min(1).max(2048) }).strict(),
]);

/**
 * Removes one of the caller's own devices, by id (the list) or by endpoint (this browser). Removing
 * what is already gone is not an error: the goal state is reached.
 */
export async function unsubscribePushAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const parsed = target.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    try {
      await unsubscribePush(await ctx(), parsed.data);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    refresh();
    return null;
  });
}

/** Whether this browser's endpoint is one of the caller's devices (the list never carries it). */
export async function findThisDeviceAction(
  endpoint: unknown,
): Promise<ActionResult<{ id: string } | null>> {
  return run(async () => {
    const parsed = z.string().min(1).max(2048).safeParse(endpoint);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    return findMyPushDevice(await ctx(), parsed.data);
  });
}

/**
 * Queues a user-scoped test notification. The worker's push-delivery job (every minute) sends it to
 * all of the caller's devices; the web app has no queue connection, so it does not enqueue.
 */
export async function sendTestPushAction(): Promise<ActionResult<{ created: boolean }>> {
  return run(async () => sendTestPush(await ctx()));
}
