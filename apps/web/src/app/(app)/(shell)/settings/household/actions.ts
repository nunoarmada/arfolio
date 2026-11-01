'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { rememberLocale } from '@/lib/locale-cookie';
import {
  AiUnavailableError,
  getHouseholdSettings,
  householdSettingsSchema,
  updateHouseholdName,
  updateHouseholdSettings,
} from '@/server/household';
import { ForbiddenError } from '@/server/session';

export interface HouseholdFormState {
  status: 'idle' | 'saved' | 'invalid' | 'forbidden' | 'error';
  /** Changes on every attempt so the client can react to repeated identical outcomes. */
  at: number;
}

export async function saveHouseholdAction(
  _prev: HouseholdFormState,
  form: FormData,
): Promise<HouseholdFormState> {
  const at = Date.now();
  try {
    const h = await headers();
    // The budget year start lives in Settings > Budget now: keep whatever is stored.
    const { fiscalYearStartMonth } = await getHouseholdSettings(h);
    const values = householdSettingsSchema.parse({
      currency: form.get('currency'),
      locale: form.get('locale'),
      timezone: form.get('timezone'),
      fiscalYearStartMonth,
      emergencyFundMonths: Number(form.get('emergencyFundMonths')),
      aiEnabled: form.get('aiEnabled') === 'true',
    });
    await updateHouseholdSettings(h, values);
    await updateHouseholdName(h, form.get('name'));
    revalidatePath('/settings/household');
    // The household language is also the owner's UI language on this device.
    await rememberLocale(values.locale);
    return { status: 'saved', at };
  } catch (error) {
    if (error instanceof ForbiddenError) return { status: 'forbidden', at };
    if (error instanceof ZodError || error instanceof AiUnavailableError) {
      return { status: 'invalid', at };
    }
    // requireMember redirects/404s are control-flow errors and must pass through.
    if (typeof (error as { digest?: unknown })?.digest === 'string') throw error;
    console.error(
      `household save failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return { status: 'error', at };
  }
}
