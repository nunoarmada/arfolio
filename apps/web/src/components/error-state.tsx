'use client';

import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** Inline error in place of content: what failed plus a retry, never a blank screen. */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('errors');
  const common = useTranslations('common');
  return (
    <Alert
      tone="error"
      title={t('title')}
      action={
        <Button variant="outline" onClick={onRetry}>
          {common('retry')}
        </Button>
      }
    >
      {t('body')}
    </Alert>
  );
}
