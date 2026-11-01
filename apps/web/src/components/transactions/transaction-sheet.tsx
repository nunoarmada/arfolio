'use client';

import { useTranslations } from 'next-intl';
import type { AccountDto, CategoryDto, GroupDto, TxDto } from '@/server/serialize';
import { Sheet } from '../ui/sheet';
import { TransactionDetail } from './transaction-detail';

/** The detail as a sheet: bottom on phones, 480px on the right from md up. */
export function TransactionSheet({
  tx,
  onClose,
  onOpenOther,
  onOthersChanged,
  ...rest
}: {
  tx: TxDto | null;
  onClose: () => void;
  onOpenOther?: (id: string) => void;
  onOthersChanged?: () => void;
  accounts: AccountDto[];
  categories: CategoryDto[];
  groups: GroupDto[];
  recentIds: string[];
  canWrite: boolean;
  onChange: (tx: TxDto) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations('transactions');
  return (
    <Sheet
      open={tx !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('detailTitle')}
      titleHidden
      tall
    >
      {tx ? (
        <TransactionDetail
          key={tx.id}
          tx={tx}
          accounts={rest.accounts}
          categories={rest.categories}
          groups={rest.groups}
          recentIds={rest.recentIds}
          canWrite={rest.canWrite}
          onChange={rest.onChange}
          onDeleted={() => {
            rest.onDeleted(tx.id);
            onClose();
          }}
          onOpenOther={onOpenOther}
          onOthersChanged={onOthersChanged}
        />
      ) : null}
    </Sheet>
  );
}
