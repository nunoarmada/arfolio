'use client';

import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

/**
 * A bottom sheet on phones (up to 90% of the screen) and a 480px panel on the right from md up.
 * Focus is trapped and returned to the trigger; it closes with the button and Esc, never only by
 * dragging. `footer` stays pinned below the scrolling body.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  tall = false,
  titleHidden = false,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Fills 90% of the phone screen instead of fitting its content. */
  tall?: boolean;
  /** The visible heading lives in `children` (e.g. the detail header). */
  titleHidden?: boolean;
  /** Where focus lands on open (call preventDefault to take over). */
  onOpenAutoFocus?: (event: Event) => void;
  /** Where focus goes on close (call preventDefault to take over). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const common = useTranslations('common');
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed z-50 flex flex-col bg-surface-raised shadow-overlay outline-none',
            'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=open]:duration-[260ms]',
            'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=closed]:duration-[180ms]',
            'md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[480px] md:rounded-none md:pb-0',
            'md:data-[state=open]:slide-in-from-right md:data-[state=closed]:slide-out-to-right',
            tall && 'h-[90dvh] md:h-auto',
          )}
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-10 rounded-full bg-surface-3 md:hidden"
          />
          <div className="flex items-start gap-2 px-4 pt-2 md:pt-4">
            <div className="min-w-0 flex-1 pt-1.5">
              <Dialog.Title className={cn('text-lg font-semibold', titleHidden && 'sr-only')}>
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label={common('close')}
              className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <X className="size-6" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">{children}</div>
          {footer ? <div className="border-t px-4 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
