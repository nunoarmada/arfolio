'use server';

import { revalidatePath } from 'next/cache';
import { rememberPrivacy } from '@/lib/privacy-cookie';

/** Remembers privacy mode on this device and re-renders, so server-rendered amounts follow. */
export async function setPrivacyAction(hidden: boolean): Promise<void> {
  if (typeof hidden !== 'boolean') return;
  await rememberPrivacy(hidden);
  revalidatePath('/', 'layout');
}
