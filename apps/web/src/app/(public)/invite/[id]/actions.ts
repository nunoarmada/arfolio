'use server';

import { isAPIError } from 'better-auth/api';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { getAuth } from '@/lib/auth';
import { acceptInvitationAndRegister, InvalidInvitationError } from '@/server/invitations';

export interface InviteState {
  error?: 'invalid' | 'exists' | 'name' | 'password' | 'unknown';
  name?: string;
}

const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
};

/** Registers the invitee (the token travels in a hidden field, never in the URL) and signs them in. */
export async function acceptInviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const name = text(form, 'name');
  const password = text(form, 'password');
  let email: string;
  try {
    const accepted = await acceptInvitationAndRegister({
      invitationId: text(form, 'invitationId'),
      token: text(form, 'token'),
      name,
      password,
    });
    email = accepted.email;
  } catch (error) {
    if (error instanceof InvalidInvitationError) return { error: 'invalid', name };
    if (error instanceof ZodError) {
      const first = String(error.issues[0]?.path[0]);
      return {
        error: first === 'password' ? 'password' : first === 'name' ? 'name' : 'unknown',
        name,
      };
    }
    if (isAPIError(error) && /exist/i.test(`${error.body?.code ?? ''} ${error.message}`)) {
      return { error: 'exists', name };
    }
    console.error(
      `invitation accept failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return { error: 'unknown', name };
  }

  try {
    await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (error) {
    console.error(
      `sign-in after invitation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    redirect('/sign-in');
  }
  redirect('/');
}
