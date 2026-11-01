'use server';

import { revalidatePath } from 'next/cache';
import { isLocale } from '@/i18n/locales';
import { rememberLocale } from '@/lib/locale-cookie';

/** Remembers the visitor's UI language and re-renders the page. */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get('locale');
  if (!isLocale(locale)) return;
  await rememberLocale(locale);
  revalidatePath('/', 'layout');
}
