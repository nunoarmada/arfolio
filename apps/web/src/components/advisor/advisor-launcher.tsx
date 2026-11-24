'use client';

import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAdvisor } from './advisor-context';

/** Id of the floating window, which the launcher controls. */
export const ADVISOR_WINDOW_ID = 'advisor-window';

/**
 * The round button in the bottom-right corner that opens the advisor. Not rendered when the
 * advisor is unavailable, on its own page, or while the floating window (which takes its corner)
 * is open. A neutral dot, not a red one, says a check-in is waiting.
 */
export function AdvisorLauncher() {
  const t = useTranslations('advisor');
  const advisor = useAdvisor();
  if (!advisor.available || advisor.onAdvisorPage) return null;
  if (advisor.open && advisor.desktop) return null;
  return (
    <button
      ref={advisor.launcherRef}
      type="button"
      aria-label={advisor.unreadProactive ? t('unread') : t('open')}
      aria-expanded={advisor.open}
      aria-controls={ADVISOR_WINDOW_ID}
      onClick={() => advisor.openAdvisor()}
      className="fixed bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+1rem)] right-4 z-50 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-raised transition-colors duration-[120ms] hover:bg-primary-hover md:bottom-6 md:right-6"
    >
      <MessageCircle className="size-6" aria-hidden="true" />
      {advisor.unreadProactive ? (
        <span
          data-unread=""
          aria-hidden="true"
          className="absolute right-0 top-0 size-3 rounded-full bg-foreground ring-2 ring-surface"
        />
      ) : null}
    </button>
  );
}
