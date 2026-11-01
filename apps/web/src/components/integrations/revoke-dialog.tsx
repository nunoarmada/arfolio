'use client';

import { AlertDialog } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

/**
 * Confirmation for revoking a credential. Controlled, unlike ConfirmDialog, because it must stay
 * open with an inline error when the revocation fails (ConfirmDialog closes on its action and has
 * no error slot). Focus starts on Cancel and is placed by the caller on close.
 */
export function RevokeDialog({
  open,
  title,
  description,
  confirmLabel,
  error,
  pending,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  error: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const common = useTranslations('common');
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-[70] grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <AlertDialog.Title className="break-words text-lg font-semibold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-base text-muted-foreground">
            {description}
          </AlertDialog.Description>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" disabled={pending}>
                {common('cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button variant="destructive" loading={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
