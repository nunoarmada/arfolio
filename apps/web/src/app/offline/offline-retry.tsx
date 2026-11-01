'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Status = 'idle' | 'checking' | 'still' | 'back';

/** Re-checks the connection against the (uncached) health endpoint, then reloads the original URL. */
export function OfflineRetry() {
  const t = useTranslations('offline');
  const [status, setStatus] = useState<Status>('idle');
  const busy = useRef(false);

  const check = useCallback(async (auto: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setStatus('checking');
    try {
      // Any HTTP answer proves the network is back; only a rejected fetch means still offline.
      await fetch('/api/health', { cache: 'no-store' });
      setStatus('back');
      window.location.reload();
    } catch {
      setStatus(auto ? 'idle' : 'still');
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    const onOnline = () => void check(true);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [check]);

  return (
    <>
      <Button
        size="lg"
        className="w-full"
        loading={status === 'checking'}
        onClick={() => void check(false)}
      >
        {status === 'checking' ? t('checking') : t('retry')}
      </Button>
      <p role="status" className="mt-3 min-h-5 text-sm text-muted-foreground">
        {status === 'still' ? t('still') : status === 'back' ? t('back') : ''}
      </p>
    </>
  );
}
