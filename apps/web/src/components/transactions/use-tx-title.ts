'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { humaniseCode, txTitle } from '@/lib/transaction-display';

/** Operation codes with a translated name; any other code is shown humanised. */
export const LABELLED_OPERATIONS = [
  'INTEREST_ON_FREE_CASH',
  'DEPOSIT',
  'WITHDRAW',
  'FEE',
  'TRANSFER',
  'SPENDING_CASHBACK',
] as const;

/** `txTitle` with bare provider operation codes shown by name in the current language. */
export function useTxTitle() {
  const t = useTranslations('transactions.operation');
  return useCallback(
    (tx: Parameters<typeof txTitle>[0]) =>
      txTitle(tx, (code) =>
        (LABELLED_OPERATIONS as readonly string[]).includes(code) ? t(code) : humaniseCode(code),
      ),
    [t],
  );
}
