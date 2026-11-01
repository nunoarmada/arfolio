'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition, type MouseEvent } from 'react';
import { deleteAssetAction, deleteLiabilityAction } from '@/server/actions/net-worth';
import { ConfirmDialog } from '../ui/alert-dialog';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/**
 * "Apagar…" (owners only, from the record's "⋯" menu): deletes the record and its history for
 * good. A confirmation without a typed name; on a live record it points to the reversible
 * alternative first.
 */
export function DeleteRecord({
  mode,
  id,
  name,
  live,
  hasLinkedCredits = false,
  open,
  onOpenChange: setOpen,
  onCloseAutoFocus,
}: {
  mode: 'asset' | 'liability';
  id: string;
  name: string;
  /** Not yet sold, written off or settled: the body suggests that instead. */
  live: boolean;
  /** Asset only: credits linked to it that will lose the link. */
  hasLinkedCredits?: boolean;
  /** Controlled: the dialog opens from the record's "more actions" menu. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the dialog closes without deleting (the menu's trigger). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('deleteRecord');
  const common = useTranslations('common');
  const errors = useTranslations('actionErrors');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, start] = useTransition();

  const description = [
    t(`${mode}Body`),
    live ? t(`${mode}Live`) : null,
    mode === 'asset' && hasLinkedCredits ? t('assetLinked') : null,
  ]
    .filter(Boolean)
    .join(' ');

  function remove(event: MouseEvent<HTMLButtonElement>) {
    // The dialog stays open until the delete succeeded: a failure is explained over it.
    event.preventDefault();
    start(async () => {
      const result =
        mode === 'asset' ? await deleteAssetAction(id) : await deleteLiabilityAction(id);
      if (!result.ok) {
        // The generic "forbidden" copy says the profile can only read, which is wrong for a member.
        toast.error(result.code === 'forbidden' ? errors('deleteForbidden') : failure(result));
        return;
      }
      setOpen(false);
      toast.success(t(`${mode}Done`));
      router.push('/net-worth');
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      title={t(`${mode}Title`, { name })}
      description={description}
      confirmLabel={pending ? t('pending') : t('confirm')}
      cancelLabel={common('cancel')}
      onConfirm={remove}
      pending={pending}
    />
  );
}
