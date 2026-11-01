'use client';

import { Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '../ui/button';

const item =
  'flex min-h-11 cursor-pointer items-center rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

/** The trigger's id: the manual-entry sheet (opened from a menu item) returns focus here. */
export const ADD_TRIGGER_ID = 'transactions-add-trigger';

/** "Adicionar" in the page header: a manual movement (opens the sheet through `?add=manual`) or an import. */
export function AddMenu({
  importAccountId,
  variant = 'default',
}: {
  importAccountId?: string;
  /** The primary action of a page, or a secondary one beside another primary (the account page). */
  variant?: 'default' | 'outline';
}) {
  const t = useTranslations('transactions');
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button id={ADD_TRIGGER_ID} variant={variant}>
          <Plus className="size-5" aria-hidden="true" />
          {t('add')}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-56 rounded-lg bg-surface-raised p-1 shadow-raised"
        >
          <DropdownMenu.Item
            className={item}
            onSelect={() => {
              const params = new URLSearchParams(search.toString());
              params.set('add', 'manual');
              router.replace(`${pathname}?${params.toString()}`, { scroll: false });
            }}
          >
            {t('addManual')}
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link
              href={importAccountId ? `/import?account=${importAccountId}` : '/import'}
              className={item}
            >
              {t('addImport')}
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
