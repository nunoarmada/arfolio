'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime } from '@/lib/dates';
import { useHouseholdFormat } from '../household-format';
import { Button } from '../ui/button';
import { SectionHeader } from '../ui/section-header';
import { UndoImportDialog } from './undo-import-dialog';

export interface ImportBatchDto {
  id: string;
  filename: string;
  createdAt: string;
  rowsImported: number;
  rowsDuplicate: number;
  undone: boolean;
}

/** Recent imports of an account, each with "Desfazer importação" while it can still be undone. */
export function ImportBatches({
  batches,
  canWrite,
}: {
  batches: ImportBatchDto[];
  canWrite: boolean;
}) {
  const t = useTranslations('import.batches');
  const router = useRouter();
  const { locale, timeZone } = useHouseholdFormat();
  const [undoing, setUndoing] = useState<string | null>(null);
  if (batches.length === 0) return null;
  return (
    <section aria-labelledby="batches-title" className="grid grid-cols-1 gap-3">
      <SectionHeader id="batches-title" title={t('title')} />
      <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card">
        {batches.map((b) => (
          <li
            key={b.id}
            className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
          >
            <span className="grid min-w-0 flex-1 basis-48 grid-cols-1">
              <span className="truncate text-base font-medium">{b.filename}</span>
              <span className="text-label font-normal text-muted-foreground">
                {formatDateTime(b.createdAt, locale, timeZone)} ·{' '}
                {t('counts', { imported: b.rowsImported, duplicates: b.rowsDuplicate })}
              </span>
            </span>
            {b.undone ? (
              <span className="shrink-0 text-sm text-muted-foreground">{t('undone')}</span>
            ) : canWrite ? (
              <Button variant="outline" size="sm" onClick={() => setUndoing(b.id)}>
                {t('undo')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {undoing ? (
        <UndoImportDialog
          batchId={undoing}
          open
          onOpenChange={(open) => !open && setUndoing(null)}
          onUndone={() => {
            setUndoing(null);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
