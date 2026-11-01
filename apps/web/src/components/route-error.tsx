'use client';

import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * What a route's error boundary shows: the failure card (tone icon tile, what happened, retry as
 * a secondary button), centred in the space it replaces. It names the problem and the next step.
 */
export function RouteError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('errors');
  const common = useTranslations('common');
  return (
    <Card
      as="section"
      role="alert"
      aria-labelledby="route-error-title"
      pad="md"
      className="mx-auto flex w-full max-w-[440px] flex-col items-start gap-3 md:p-6"
    >
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-lg bg-negative-soft text-negative"
      >
        <TriangleAlert className="size-5" />
      </span>
      <h1 id="route-error-title" className="text-heading">
        {t('title')}
      </h1>
      <p className="max-w-[52ch] text-sm text-muted-foreground">{t('body')}</p>
      <Button variant="secondary" onClick={onRetry}>
        {common('retry')}
      </Button>
    </Card>
  );
}
