/**
 * The interface languages the app ships, as BCP 47 tags. Order is the order shown in language
 * pickers. Anything else (a stored legacy value, an unknown header) resolves to English.
 */
export const APP_LOCALES = ['pt-PT', 'es-ES', 'fr-FR', 'it-IT', 'en'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** The primary language of each app locale; content tables keyed by language use these. */
export type AppLanguage = 'pt' | 'es' | 'fr' | 'it' | 'en';

const LANGUAGE_LOCALE: Record<AppLanguage, AppLocale> = {
  pt: 'pt-PT',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  en: 'en',
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

/** The app language for any locale tag by its language subtag ("pt-BR" is pt, "de" is en). */
export function appLanguage(locale: string): AppLanguage {
  const lang = locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return lang in LANGUAGE_LOCALE ? (lang as AppLanguage) : 'en';
}

/** The app locale for any locale tag: exact match, else the one sharing its language, else en. */
export function resolveAppLocale(locale: string): AppLocale {
  return isAppLocale(locale) ? locale : LANGUAGE_LOCALE[appLanguage(locale)];
}
