'use client';

import { ArrowLeftRight, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { cn } from '@/lib/cn';
import { moneyKindOf } from '@/lib/transaction-display';
import type { AccountDto, CategoryDto, TxDto } from '@/server/serialize';
import { AccountBadge } from '../account-badge';
import { AiBadge } from '../ai-badge';
import { MerchantAvatar } from '../merchant-avatar';
import { MoneyAmount } from '../money-amount';
import { useTxTitle } from './use-tx-title';

/** Wraps the part of `text` matching `term` (case-insensitive) in <mark>. */
function highlight(text: string, term: string) {
  const needle = term.trim();
  if (!needle) return text;
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return text;
  return (
    <Fragment>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-primary-soft px-0.5 text-foreground">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </Fragment>
  );
}

/**
 * One movement: merchant logo over the category disc, title, "category · account", then the status marks and the amount.
 * The whole row is a button (opens the detail). from lg; below, the account joins the meta line.
 */
export function TransactionRow({
  tx,
  category,
  account,
  onOpen,
  search = '',
  signedTransfers = false,
  onUndoAi,
}: {
  tx: TxDto;
  category: CategoryDto | undefined;
  account: AccountDto | undefined;
  onOpen: () => void;
  search?: string;
  /** Inside one account a transfer shows its sign (its effect on that account). */
  signedTransfers?: boolean;
  /** Shows the one-tap "undo AI categorisation" button beside the row (the `?by=ai` list). */
  onUndoAi?: () => void;
}) {
  const t = useTranslations('transactions');
  const titleOf = useTxTitle();
  const isTransfer = tx.transferGroupId !== null;
  const pending = tx.status === 'pending';
  const categoryName = category?.name ?? t('uncategorised');
  const byAi = tx.categorisedBy === 'ai' && tx.categoryId !== null;
  const ai = useTranslations('ai');

  const open = (
    <button
      type="button"
      onClick={onOpen}
      className="grid min-h-15 w-full min-w-0 flex-1 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-left outline-none transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:min-h-14 lg:grid-cols-[2.25rem_minmax(0,2fr)_minmax(0,1fr)_minmax(10rem,1fr)_9rem]"
    >
      <MerchantAvatar merchant={tx.merchant} category={category} size={36} />
      <span className="grid grid-cols-1 min-w-0">
        <span className="truncate text-[15px] font-medium leading-5">
          {highlight(titleOf(tx), search)}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-label font-normal text-muted-foreground lg:hidden">
          {byAi ? <AiBadge /> : null}
          <span className="truncate">
            {categoryName}
            {account ? ` · ${account.name}` : ''}
          </span>
        </span>
      </span>
      <span
        className={cn(
          'hidden min-w-0 items-center gap-1.5 text-sm lg:flex',
          category ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span className="truncate">{categoryName}</span>
        {byAi ? <AiBadge /> : null}
      </span>
      <span className="hidden min-w-0 lg:block">
        {account ? <AccountBadge name={account.name} /> : null}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2 whitespace-nowrap">
        {tx.needsReview ? (
          <span className="flex size-3 items-center justify-center" title={t('needsReview')}>
            <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
            <span className="sr-only">{t('needsReview')}</span>
          </span>
        ) : null}
        {isTransfer ? <ArrowLeftRight className="size-4 text-transfer" aria-hidden="true" /> : null}
        <MoneyAmount
          minor={tx.amount}
          currency={tx.currency}
          kind={moneyKindOf(tx)}
          pending={pending}
          showSign={isTransfer ? signedTransfers : undefined}
          className="font-semibold"
        />
      </span>
    </button>
  );
  if (!onUndoAi) return open;
  // The undo button is a sibling, never nested inside the row's own button.
  return (
    <div className="flex items-center">
      {open}
      <button
        type="button"
        data-undo={tx.id}
        aria-label={ai('undoLabel', { title: titleOf(tx) })}
        title={ai('undo')}
        onClick={onUndoAi}
        className="mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-surface-2 hover:text-foreground"
      >
        <Undo2 className="size-5" aria-hidden="true" />
      </button>
    </div>
  );
}
