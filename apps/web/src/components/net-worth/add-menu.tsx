'use client';

import { Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '../ui/button';

const item =
  'flex min-h-11 cursor-pointer items-center rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

/** "Adicionar" on the Património page: an asset, a liability, or the spreadsheet import. */
export function NetWorthAddMenu() {
  const t = useTranslations('netWorth');
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('add')} title={t('add')}>
          <Plus className="size-6" aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-60 rounded-lg bg-surface-raised p-1 shadow-raised"
        >
          <DropdownMenu.Item asChild>
            <Link href="/net-worth/assets/new" className={item}>
              {t('addAsset')}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/net-worth/liabilities/new" className={item}>
              {t('addLiability')}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/import/budget" className={item}>
              {t('importSheet')}
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
