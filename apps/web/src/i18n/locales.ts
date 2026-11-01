import { APP_LOCALES, type AppLocale } from '@arfolio/core';

export const LOCALES = APP_LOCALES;
export type Locale = AppLocale;
export const LOCALE_COOKIE = 'locale';
export const FALLBACK_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Short labels for the language switch; each language is named in itself. */
export const LOCALE_LABELS: Record<Locale, { short: string; name: string }> = {
  'pt-PT': { short: 'PT', name: 'Português' },
  'es-ES': { short: 'ES', name: 'Español' },
  'fr-FR': { short: 'FR', name: 'Français' },
  'it-IT': { short: 'IT', name: 'Italiano' },
  en: { short: 'EN', name: 'English' },
};
