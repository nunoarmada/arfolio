'use client';

import { Archive, MoreHorizontal, Pencil, Trash2, Upload } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveAccountAction } from '@/server/actions/accounts';
import type { AccountDto } from '@/server/serialize';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button, buttonVariants } from '../ui/button';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';
import { AccountFormSheet } from './account-form-sheet';
import { DeleteAccountDialog } from './delete-account-dialog';

const moreId = (accountId: string) => `account-more-${accountId}`;

const item =
  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2 lg:pointer-fine:min-h-9 lg:pointer-fine:text-sm';

/**
 * The account toolbar (members and owners): Importar extrato (primary), Editar (secondary) and a
 * "more actions" menu holding Arquivar and, for owners, Apagar conta. The destructive entry
 * points live in the menu; both still open their confirmation dialogs.
 */
export function AccountActions({
  account,
  currencies,
  isOwner,
}: {
  account: AccountDto;
  currencies: Array<{ value: string; label: string }>;
  isOwner: boolean;
}) {
  const t = useTranslations('accounts');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, startTransition] = useTransition();
  const hasMenu = !account.archived || isOwner;
  // The dialogs open from menu items, so they have no Trigger: Radix would drop focus on <body>.
  const returnFocus = (e: Event) => {
    const target = document.getElementById(moreId(account.id));
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {account.archived ? null : (
        <Link href={`/import?account=${account.id}`} className={buttonVariants()}>
          <Upload className="size-5 max-sm:hidden lg:pointer-fine:size-4" aria-hidden="true" />
          {t('importStatement')}
        </Link>
      )}
      <Button variant="outline" onClick={() => setEditing(true)}>
        <Pencil className="size-5 max-sm:hidden lg:pointer-fine:size-4" aria-hidden="true" />
        {t('edit')}
      </Button>
      {hasMenu ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              id={moreId(account.id)}
              variant="outline"
              size="icon"
              aria-label={t('moreActions')}
            >
              <MoreHorizontal className="size-5" aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-50 min-w-52 rounded-lg bg-surface-raised p-1 shadow-raised"
            >
              {account.archived ? null : (
                <DropdownMenu.Item className={item} onSelect={() => setArchiving(true)}>
                  <Archive className="size-4 text-muted-foreground" aria-hidden="true" />
                  {t('archive')}
                </DropdownMenu.Item>
              )}
              {isOwner ? (
                <DropdownMenu.Item
                  className={`${item} text-negative`}
                  onSelect={() => setDeleting(true)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {t('delete')}
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t('archiveTitle', { name: account.name })}
        description={t('archiveBody')}
        confirmLabel={t('archive')}
        cancelLabel={common('cancel')}
        pending={pending}
        onCloseAutoFocus={returnFocus}
        onConfirm={() =>
          startTransition(async () => {
            const result = await archiveAccountAction(account.id);
            if (!result.ok) return report(result);
            toast.success(t('archived_done'));
            router.push('/accounts');
          })
        }
      />
      {isOwner ? (
        <DeleteAccountDialog
          account={account}
          open={deleting}
          onOpenChange={setDeleting}
          onCloseAutoFocus={returnFocus}
        />
      ) : null}
      <AccountFormSheet
        open={editing}
        onOpenChange={setEditing}
        account={account}
        currencies={currencies}
        defaultCurrency={account.currency}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
