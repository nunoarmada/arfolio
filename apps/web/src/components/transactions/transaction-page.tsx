'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AccountDto, CategoryDto, GroupDto, TxDto } from '@/server/serialize';
import { TransactionDetail } from './transaction-detail';

/** The detail as a full page (direct load or deep link). */
export function TransactionPage({
  tx: initial,
  ...rest
}: {
  tx: TxDto;
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
  recentIds: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [tx, setTx] = useState(initial);
  return (
    <TransactionDetail
      tx={tx}
      accounts={rest.accounts}
      categories={rest.categories}
      groups={rest.groups}
      recentIds={rest.recentIds}
      canWrite={rest.canWrite}
      onChange={(changed) => setTx((cur) => (cur.id === changed.id ? changed : cur))}
      onDeleted={() => router.replace('/transactions')}
      onOpenOther={(id) => router.push(`/transactions/${id}`)}
    />
  );
}
