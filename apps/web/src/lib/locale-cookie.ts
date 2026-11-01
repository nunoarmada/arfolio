import { cookies } from 'next/headers';
import { LOCALE_COOKIE, type Locale } from '@/i18n/locales';

/** Stores the UI language cookie (365 days). Call from server actions only. */
export async function rememberLocale(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: true,
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
  });
}
