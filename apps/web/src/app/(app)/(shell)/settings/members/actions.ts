'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { ROLES } from '@/lib/access';
import { getAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getInvitationMailer } from '@/server/mail';
import { createInvitation, NotAllowedError, TwoFactorRequiredError } from '@/server/invitations';
import { MemberActionError, removeMember, revokeInvitation } from '@/server/members';
import { ForbiddenError } from '@/server/session';

export interface InviteState {
  status: 'idle' | 'created' | 'invalid' | 'forbidden' | 'error';
  /** True when the invitation email was handed to SMTP; false when SMTP is unset or failed. */
  emailed?: boolean;
  /** The full invitation link; returned once, the token cannot be read back later. */
  link?: string;
  email?: string;
  at: number;
}

export type ActionResult = { ok: true } | { ok: false; reason: 'forbidden' | 'error' };

/** Redirects and 404s raised by the session guard are control flow: let Next handle them. */
function rethrowControlFlow(error: unknown): void {
  if (typeof (error as { digest?: unknown })?.digest === 'string') throw error;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

const roleSchema = z.enum(ROLES);

export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const at = Date.now();
  const email = String(form.get('email') ?? '');
  try {
    const role = roleSchema.parse(form.get('role'));
    const mailer = await getInvitationMailer();
    let emailed = false;
    const created = await createInvitation(
      { headers: await headers(), email, role },
      {
        db: getDb(),
        auth: getAuth(),
        // The invitation exists once created: a failing SMTP server must not turn that into an error.
        sendInvitationEmail: mailer
          ? async (msg) => {
              try {
                await mailer({ ...msg, link: new URL(msg.link, getEnv().APP_URL).toString() });
                emailed = true;
              } catch (error) {
                console.error(`invitation email failed: ${describe(error)}`);
              }
            }
          : undefined,
      },
    );
    revalidatePath('/settings/members');
    return {
      status: 'created',
      link: new URL(created.path, getEnv().APP_URL).toString(),
      email: email.toLowerCase(),
      emailed,
      at,
    };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ZodError) return { status: 'invalid', email, at };
    if (
      error instanceof NotAllowedError ||
      error instanceof TwoFactorRequiredError ||
      error instanceof ForbiddenError
    ) {
      return { status: 'forbidden', email, at };
    }
    console.error(`invite failed: ${describe(error)}`);
    return { status: 'error', email, at };
  }
}

async function run(fn: () => Promise<void>, path: string): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath(path);
    return { ok: true };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ForbiddenError) return { ok: false, reason: 'forbidden' };
    if (!(error instanceof MemberActionError))
      console.error(`member action failed: ${describe(error)}`);
    return { ok: false, reason: 'error' };
  }
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  return run(async () => revokeInvitation(await headers(), invitationId), '/settings/members');
}

export async function removeMemberAction(memberId: string): Promise<ActionResult> {
  return run(async () => removeMember(await headers(), memberId), '/settings/members');
}
