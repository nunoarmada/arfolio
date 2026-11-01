'use client';

import { AlertDialog } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Remove confirmation. Unlike the generic ConfirmDialog it stays open when the removal is refused
 * (a sync is running) and shows why. Cancel has the initial focus.
 */
export function RemoveConnectionDialog({
  open,
  onOpenChange,
  name,
  provider,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  provider: 'enablebanking' | 'trading212';
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const t = useTranslations('connections.remove');
  const common = useTranslations('common');
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <AlertDialog.Title className="text-lg font-semibold">
            {t('title', { name })}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-base text-muted-foreground">
            {provider === 'trading212' ? t('bodyT212') : t('body')}
          </AlertDialog.Description>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{common('cancel')}</Button>
            </AlertDialog.Cancel>
            <Button variant="destructive" loading={pending} onClick={onConfirm}>
              {t('confirm')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
