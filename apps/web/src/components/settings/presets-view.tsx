'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { deletePresetAction } from '@/server/actions/imports';
import { EmptyState } from '../empty-state';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';

export interface PresetRow {
  id: string;
  name: string;
  kind: 'csv' | 'xlsx';
  columns: string[];
}

/** Saved import formats of the household; they are recognised automatically on later files. */
export function PresetsView({ presets, canWrite }: { presets: PresetRow[]; canWrite: boolean }) {
  const t = useTranslations('presets');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [pending, startTransition] = useTransition();

  if (presets.length === 0)
    return <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>;
  return (
    <div className="grid grid-cols-1 gap-3">
      <p className="max-w-[68ch] text-sm text-muted-foreground">{t('intro')}</p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card">
        {presets.map((p) => (
          <li
            key={p.id}
            className="flex min-h-16 items-center gap-3 py-2 pl-4 pr-1 md:pl-5 md:pr-2"
          >
            <span className="grid grid-cols-1 min-w-0 flex-1">
              <span className="truncate text-base font-medium">{p.name}</span>
              <span className="truncate text-sm text-muted-foreground">
                {p.kind.toUpperCase()} · {p.columns.join(', ')}
              </span>
            </span>
            {canWrite ? (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" size="icon" aria-label={t('delete', { name: p.name })}>
                    <Trash2 className="size-5" aria-hidden="true" />
                  </Button>
                }
                title={t('deleteTitle', { name: p.name })}
                description={t('deleteBody')}
                confirmLabel={t('deleteConfirm')}
                cancelLabel={common('cancel')}
                pending={pending}
                onConfirm={() =>
                  startTransition(async () => {
                    const result = await deletePresetAction(p.id);
                    if (!result.ok) return report(result);
                    toast.success(t('deleted'));
                    router.refresh();
                  })
                }
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
