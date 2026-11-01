'use client';

import { MoreHorizontal, Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { Button, buttonVariants } from '../ui/button';

const item =
  'flex min-h-11 cursor-pointer items-center rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2 md:pointer-fine:min-h-9 md:pointer-fine:text-sm';

/**
 * The right side of the year toolbar: "Adicionar rubrica" for people who can edit, and a "⋯" menu
 * with the rarer ways on (import, a new budget) and the list of all budgets for everyone.
 */
export function YearActions({ canWrite, addLineHref }: { canWrite: boolean; addLineHref: string }) {
  const t = useTranslations('budgetYear');
  return (
    <div className="flex items-center gap-2">
      {canWrite ? (
        <Link
          href={addLineHref}
          className={cn(buttonVariants({ variant: 'outline' }), 'max-sm:w-11 max-sm:px-0')}
        >
          <Plus className="size-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{t('addLine')}</span>
        </Link>
      ) : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('moreActions')}
            title={t('moreActions')}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-60 rounded-lg bg-surface-raised p-1 shadow-raised"
          >
            {canWrite ? (
              <>
                <DropdownMenu.Item asChild>
                  <Link href="/import/budget" className={item}>
                    {t('import')}
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <Link href="/budget/new" className={item}>
                    {t('newBudget')}
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
              </>
            ) : null}
            <DropdownMenu.Item asChild>
              <Link href="/budget/all" className={item}>
                {t('manage')}
              </Link>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
