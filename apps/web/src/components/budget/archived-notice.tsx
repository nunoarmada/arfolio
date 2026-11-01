'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setBudgetArchivedAction } from '@/server/actions/budget';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/** Shown on a budget that was archived and opened on purpose; writers can bring it back. */
export function ArchivedNotice({
  budgetId,
  canWrite,
  className,
}: {
  budgetId: string;
  canWrite: boolean;
  className?: string;
}) {
  const t = useTranslations('budgetList');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function restore() {
    setError(null);
    startTransition(async () => {
      const result = await setBudgetArchivedAction(budgetId, false);
      if (!result.ok) return setError(failure(result));
      toast.success(t('restored'));
      router.replace('/budget');
      router.refresh();
    });
  }

  return (
    <Alert
      tone="info"
      className={className}
      action={
        canWrite ? (
          <Button variant="outline" loading={pending} onClick={restore}>
            {t('restore')}
          </Button>
        ) : undefined
      }
    >
      {error ?? t('archivedNotice')}
    </Alert>
  );
}
