import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { FALLBACK_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from './locales';

/** The installation default; read from process.env directly so `next build` needs no runtime env. */
function defaultLocale(): Locale {
  const configured = process.env.DEFAULT_LOCALE;
  return isLocale(configured) ? configured : FALLBACK_LOCALE;
}

// No i18n routing: the UI language comes from the visitor's cookie, else the installation default.
export default getRequestConfig(async () => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(cookie) ? cookie : defaultLocale();
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
