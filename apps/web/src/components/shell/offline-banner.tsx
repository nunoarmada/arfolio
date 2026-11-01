'use client';

import { WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Slim banner under the top bar while the browser is offline (design system §4.4). */
export function OfflineBanner() {
  const t = useTranslations('shell');
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-warning-soft px-4 py-2 text-sm text-foreground md:px-6 xl:px-8"
    >
      <WifiOff className="size-4 shrink-0 text-warning" aria-hidden="true" />
      {t('offline')}
    </div>
  );
}
