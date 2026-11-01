import { getLocale, getTranslations } from 'next-intl/server';
import { setLocaleAction } from '@/app/actions/locale';
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales';
import { cn } from '@/lib/cn';

/** One button per UI language. Plain form buttons: works without JavaScript and keeps focus order simple. */
export async function LocaleSwitch({ className }: { className?: string }) {
  const [current, t] = await Promise.all([getLocale(), getTranslations('shell')]);
  return (
    <form action={setLocaleAction} className={className}>
      <div
        role="group"
        aria-label={t('language')}
        className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {LOCALES.map((locale) => {
          const active = locale === current;
          return (
            <button
              key={locale}
              type="submit"
              name="locale"
              value={locale}
              lang={locale}
              aria-pressed={active}
              aria-label={`${LOCALE_LABELS[locale].short}, ${LOCALE_LABELS[locale].name}`}
              className={cn(
                'min-h-11 min-w-11 rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] lg:pointer-fine:min-h-9',
                active
                  ? 'bg-surface text-primary-text shadow-card'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {LOCALE_LABELS[locale].short}
            </button>
          );
        })}
      </div>
    </form>
  );
}
