'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { archiveGoalAction } from '@/server/actions/goals';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';

/** "Arquivar objetivo": it leaves the list; an archived emergency fund frees its single slot. */
export function ArchiveGoal({ id, name }: { id: string; name: string }) {
  const t = useTranslations('goals');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [pending, start] = useTransition();

  function archive() {
    start(async () => {
      const result = await archiveGoalAction(id);
      if (!result.ok) {
        report(result);
        return;
      }
      toast.success(t('archived'));
      router.push('/net-worth/goals');
    });
  }

  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" className="justify-self-start text-negative hover:bg-negative-soft">
          {t('archive')}
        </Button>
      }
      title={t('archiveTitle', { name })}
      description={t('archiveBody')}
      confirmLabel={t('archiveConfirm')}
      cancelLabel={common('cancel')}
      onConfirm={archive}
      pending={pending}
    />
  );
}
