'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { getAuth } from '@/lib/auth';
import { clientKey, createRateLimiter } from '@/lib/rate-limit';
import { rememberLocale } from '@/lib/locale-cookie';
import { householdSettingsSchema } from '@/server/household';
import { completeSetup, InvalidSetupTokenError, SetupClosedError } from '@/server/setup';

export type SetupField =
  'token' | 'householdName' | 'name' | 'email' | 'password' | 'confirmPassword';

export interface SetupState {
  /** Form-level failure, or undefined. */
  error?: 'invalidToken' | 'closed' | 'limited' | 'unknown';
  /** Per-field problem codes (message keys under setup.errors). */
  fieldErrors?: Partial<
    Record<
      SetupField,
      'token' | 'householdName' | 'name' | 'email' | 'password' | 'passwordMismatch'
    >
  >;
  /** Entered values handed back so a failed submit keeps them (never the passwords). */
  values?: Record<string, string>;
}

/** 10 attempts per client address per 15 minutes (the token is the only secret here). */
const setupLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });

const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
};

export async function setupAction(_prev: SetupState, form: FormData): Promise<SetupState> {
  const values = {
    token: text(form, 'token'),
    householdName: text(form, 'householdName'),
    currency: text(form, 'currency'),
    locale: text(form, 'locale'),
    timezone: text(form, 'timezone'),
    fiscalYearStartMonth: text(form, 'fiscalYearStartMonth'),
    name: text(form, 'name'),
    email: text(form, 'email'),
  };
  const password = text(form, 'password');

  if (!setupLimiter.take(clientKey(await headers()))) return { error: 'limited', values };

  if (password !== text(form, 'confirmPassword')) {
    return { fieldErrors: { confirmPassword: 'passwordMismatch' }, values };
  }
  const settings = householdSettingsSchema
    .pick({ currency: true, locale: true, timezone: true, fiscalYearStartMonth: true })
    .safeParse({ ...values, fiscalYearStartMonth: Number(values.fiscalYearStartMonth) });
  if (!settings.success) return { error: 'unknown', values };

  try {
    await completeSetup({
      token: values.token,
      name: values.name,
      email: values.email,
      password,
      householdName: values.householdName,
      ...settings.data,
    });
  } catch (error) {
    if (error instanceof InvalidSetupTokenError) return { error: 'invalidToken', values };
    if (error instanceof SetupClosedError) return { error: 'closed', values };
    if (error instanceof ZodError) {
      const fieldErrors: NonNullable<SetupState['fieldErrors']> = {};
      for (const issue of error.issues) {
        const key = String(issue.path[0]);
        if (key === 'householdName') fieldErrors.householdName = 'householdName';
        else if (key === 'name') fieldErrors.name = 'name';
        else if (key === 'email') fieldErrors.email = 'email';
        else if (key === 'password') fieldErrors.password = 'password';
      }
      return Object.keys(fieldErrors).length > 0
        ? { fieldErrors, values }
        : { error: 'unknown', values };
    }
    console.error(`setup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return { error: 'unknown', values };
  }

  // Sign the new owner in (cookies are set through Better Auth's nextCookies plugin).
  await rememberLocale(settings.data.locale);
  try {
    await getAuth().api.signInEmail({
      body: { email: values.email, password },
      headers: await headers(),
    });
  } catch (error) {
    // Setup is done and cannot repeat: send the owner to sign in rather than to an error.
    console.error(
      `sign-in after setup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    redirect('/sign-in');
  }
  // Owners must enrol in two-step verification before anything else.
  redirect('/two-factor/setup');
}
