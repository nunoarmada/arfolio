'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createPat, NotFoundError, revokePat, ValidationError } from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { revokeConnectedApp } from '../oauth-apps';
import { run, type ActionResult } from './result';

async function ctx() {
  return getServiceCtx(await headers());
}

const createInput = z.object({
  name: z.string().max(60),
  scope: z.enum(['read', 'read_write']),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});

/**
 * Creates a personal access token for the caller. The plain token is in this one response and
 * nowhere else (the service stores only its hash); the page shows it once and drops it. A viewer
 * asking for read_write is refused by the service (403); a session older than 10 minutes gets
 * `reauth`.
 */
export async function createTokenAction(
  input: unknown,
): Promise<ActionResult<{ token: string; id: string; name: string }>> {
  return run(async () => {
    const parsed = createInput.safeParse(input);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    // A recent sign-in is required: the token outlives the session that asked for it.
    const fresh = await getServiceCtx(await headers(), { fresh: true });
    const { token, pat } = await createPat(fresh, parsed.data);
    revalidatePath('/settings/integrations');
    return { token, id: pat.id, name: pat.name };
  });
}

// The two revoke actions do not revalidate: the page collapses the row first and then refreshes
// itself, so the row does not vanish before its exit animation.

/** Revokes (or removes an expired) token of the caller. What is already gone counts as done. */
export async function revokeTokenAction(id: unknown): Promise<ActionResult> {
  return run(async () => {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    try {
      await revokePat(await ctx(), parsed.data);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    return null;
  });
}

/** Revokes a connected app's access for the caller (consent and tokens), audited. */
export async function revokeAppAction(clientId: unknown): Promise<ActionResult> {
  return run(async () => {
    const parsed = z.string().min(1).max(200).safeParse(clientId);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.issues);
    try {
      await revokeConnectedApp(await ctx(), parsed.data);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    return null;
  });
}
