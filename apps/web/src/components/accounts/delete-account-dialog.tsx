'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertDialog as Primitive } from 'radix-ui';
import { deleteAccountAction } from '@/server/actions/accounts';
import type { AccountDto } from '@/server/serialize';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';

/**
 * Permanently deletes an account (owners only), opened from the account's "more actions" menu. The confirm button stays disabled until the
 * account name is typed exactly (surrounding spaces ignored), so a stray click cannot delete it.
 */
export function DeleteAccountDialog({
  account,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  account: AccountDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close; the caller opened the dialog from a menu, which has no Trigger. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('accounts');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();
  const matches = typed.trim() === account.name;

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) setTyped('');
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Primitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Primitive.Title className="text-lg font-semibold">
            {t('deleteTitle', { name: account.name })}
          </Primitive.Title>
          <Primitive.Description className="text-base text-muted-foreground">
            {t('deleteBody')}
          </Primitive.Description>
          <form
            method="post"
            className="grid grid-cols-1 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!matches || pending) return;
              startTransition(async () => {
                const result = await deleteAccountAction(account.id);
                if (!result.ok) return report(result);
                toast.success(t('deleted_done'));
                onOpenChange(false);
                router.push('/accounts');
              });
            }}
          >
            <Field label={t('deleteConfirmLabel', { name: account.name })}>
              {(props) => (
                <Input
                  {...props}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                />
              )}
            </Field>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Primitive.Cancel asChild>
                <Button variant="outline" disabled={pending}>
                  {common('cancel')}
                </Button>
              </Primitive.Cancel>
              <Button type="submit" variant="destructive" disabled={!matches} loading={pending}>
                {t('delete')}
              </Button>
            </div>
          </form>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
