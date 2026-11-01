'use client';

import { useTranslations } from 'next-intl';
import { AlertDialog } from 'radix-ui';
import { useEffect, useRef, useState, useTransition } from 'react';
import { getBatchSummaryAction, undoImportAction } from '@/server/actions/imports';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/**
 * Confirms undoing an import. It reads the batch first and, when the user has edited rows that
 * would be deleted (category, notes, transfers), says how many so nothing is lost by surprise.
 */
export function UndoImportDialog({
  batchId,
  open,
  onOpenChange,
  onUndone,
}: {
  batchId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUndone: () => void;
}) {
  const t = useTranslations('import.undo');
  const common = useTranslations('common');
  const toast = useToast();
  const failure = useFailureMessage();
  const failureRef = useRef(failure);
  failureRef.current = failure;
  const [summary, setSummary] = useState<{ rows: number; editedRows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSummary(null);
    setError(null);
    void getBatchSummaryAction(batchId).then((r) => {
      if (!alive) return;
      if (r.ok) setSummary(r.data);
      else setError(failureRef.current(r));
    });
    return () => {
      alive = false;
    };
  }, [open, batchId]);

  function confirm() {
    startTransition(async () => {
      const result = await undoImportAction(batchId);
      if (!result.ok) return setError(failure(result));
      toast.success(t('done', { count: result.data.deleted }));
      onOpenChange(false);
      onUndone();
    });
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <AlertDialog.Title className="text-lg font-semibold">{t('title')}</AlertDialog.Title>
          <AlertDialog.Description className="text-base text-muted-foreground">
            {summary ? t('body', { count: summary.rows }) : t('loading')}
          </AlertDialog.Description>
          {summary && summary.editedRows > 0 ? (
            <Alert tone="warning">{t('edited', { count: summary.editedRows })}</Alert>
          ) : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{common('cancel')}</Button>
            </AlertDialog.Cancel>
            <Button variant="destructive" loading={pending} disabled={!summary} onClick={confirm}>
              {t('confirm')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
