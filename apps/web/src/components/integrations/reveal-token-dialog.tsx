'use client';

import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { CopyButton } from '../copy-button';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { IDENT } from './shared';

/**
 * Shows a new token once. Esc and the close button dismiss it, a click on the overlay does not
 * (a stray tap would lose the only copy). The token lives in the caller's state only while this
 * is open. Not an AlertDialog: nothing here is destructive.
 */
export function RevealTokenDialog({
  name,
  token,
  command,
  onClose,
}: {
  name: string;
  /** Null when closed. */
  token: string | null;
  /** The Claude Code command with this token filled in. */
  command: string;
  onClose: () => void;
}) {
  const t = useTranslations('integrations.reveal');
  const common = useTranslations('common');
  const content = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          ref={content}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            // The copy button is the first thing to do here, not the close button.
            event.preventDefault();
            content.current
              ?.querySelector<HTMLButtonElement>('[data-autofocus-wrap] button')
              ?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Back on the create button, which exists in either state of the list.
            event.preventDefault();
            document.getElementById('create-token-button')?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[70] grid grid-cols-1 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <div className="flex items-start gap-2">
            <Dialog.Title className="min-w-0 flex-1 pt-1.5 text-lg font-semibold">
              {t('title')}
            </Dialog.Title>
            <Dialog.Close
              aria-label={common('close')}
              className="-mr-2 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <X className="size-6" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Alert tone="warning">
            <Dialog.Description>{t('warning')}</Dialog.Description>
          </Alert>
          <div className="grid grid-cols-1 gap-2">
            <p id="reveal-token-label" className="break-words text-sm font-medium">
              {t('tokenLabel', { name })}
            </p>
            <p
              data-testid="revealed-token"
              role="group"
              aria-labelledby="reveal-token-label"
              className={`select-all break-all rounded-md bg-surface-2 p-3 text-base ${IDENT}`}
            >
              {token}
            </p>
            <div data-autofocus-wrap className="contents">
              <CopyButton
                text={token ?? ''}
                label={t('copy')}
                variant="default"
                className="w-full"
              />
            </div>
            <CopyButton text={command} label={t('copyCommand')} className="w-full" />
          </div>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button variant="outline" className="max-sm:w-full">
                {t('done')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
