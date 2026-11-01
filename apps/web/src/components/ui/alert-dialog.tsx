'use client';

import { AlertDialog as Primitive } from 'radix-ui';
import type { MouseEvent, ReactNode } from 'react';
import { Button } from './button';

/**
 * Confirmation for destructive or irreversible actions only. Focus moves to Cancel first, is
 * trapped while open and returns to the trigger on close (Radix), after the exit animation. A
 * caller whose action removes the trigger passes `onCloseAutoFocus` and may `preventDefault()` to
 * place focus itself.
 */
export function ConfirmDialog({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCloseAutoFocus,
  pending = false,
  confirmVariant = 'destructive',
}: {
  /** Omit when the caller controls the dialog with `open` (opened from a menu item, say). */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The dialog closes after this runs; call `event.preventDefault()` to keep it open (a failure). */
  onConfirm: (event: MouseEvent<HTMLButtonElement>) => void;
  onCloseAutoFocus?: (event: Event) => void;
  pending?: boolean;
  /** A confirmation that is not destructive (replacing text, say) uses the default look. */
  confirmVariant?: 'destructive' | 'default';
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Primitive.Trigger asChild>{trigger}</Primitive.Trigger> : null}
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Primitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Primitive.Title className="text-lg font-semibold">{title}</Primitive.Title>
          <Primitive.Description className="text-base text-muted-foreground">
            {description}
          </Primitive.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Primitive.Cancel asChild>
              <Button variant="outline">{cancelLabel}</Button>
            </Primitive.Cancel>
            <Primitive.Action asChild>
              <Button variant={confirmVariant} loading={pending} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
