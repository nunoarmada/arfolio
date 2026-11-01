'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useRef } from 'react';
import { categoriseAction, revertCategorisationAction } from '@/server/actions/transactions';
import type { CategoryDto, TxDto } from '@/server/serialize';
import { useReportFailure } from '../use-action-error';
import { useToast } from '../ui/toast';
import type { PickOptions } from '../category-picker';

export interface CategoriseHooks {
  /** Called at once, before the server answers: the UI moves on (and rolls back on failure). */
  onOptimistic?: () => void;
  /** The server refused: undo what `onOptimistic` did. */
  onRollback?: () => void;
  /** The server accepted: `tx` is the saved row, `alsoApplied` other rows of the merchant changed. */
  onApplied?: (tx: TxDto, alsoApplied: number) => void;
  /** "Anular" worked: `tx` is the row as it was (other rows may have changed back too). */
  onUndone?: (tx: TxDto, alsoApplied: number) => void;
}

/**
 * Applies a category with an undo toast ("Categorizado como X · Anular", 6 s). Undo gives the
 * server's opaque token back and the server restores everything the change touched (provenance,
 * review state, other rows of the merchant, merchant memory, a created rule). A second call for a
 * row that is still being saved is ignored. Resolves to true when the change was saved.
 */
export function useCategorise(categories: CategoryDto[]) {
  const t = useTranslations('transactions');
  const toast = useToast();
  const report = useReportFailure();
  const inFlight = useRef(new Set<string>());

  return useCallback(
    async (
      tx: TxDto,
      categoryId: string,
      options: PickOptions,
      hooks: CategoriseHooks = {},
    ): Promise<boolean> => {
      if (inFlight.current.has(tx.id)) return false;
      inFlight.current.add(tx.id);
      hooks.onOptimistic?.();
      try {
        const result = await categoriseAction({
          id: tx.id,
          categoryId,
          applyToMerchant: options.applyToMerchant,
          createRule: options.createRule,
        });
        if (!result.ok) {
          hooks.onRollback?.();
          report(result);
          return false;
        }
        const { tx: saved, alsoApplied, undoToken } = result.data;
        let undoing = false;
        hooks.onApplied?.(saved, alsoApplied);
        const name = categories.find((c) => c.id === categoryId)?.name ?? '';
        toast.success(
          alsoApplied > 0
            ? t('categorisedAlso', { category: name, count: alsoApplied })
            : t('categorisedAs', { category: name }),
          {
            label: t('undo'),
            onClick: () => {
              // One revert per toast: a second tap while the first is running is ignored.
              if (undoing) return;
              undoing = true;
              void (async () => {
                try {
                  const undone = await revertCategorisationAction(undoToken);
                  if (!undone.ok) return report(undone);
                  hooks.onUndone?.(undone.data, alsoApplied);
                  toast.success(t('undone'));
                } catch {
                  // Transport failure: nothing reached the server, so the user may try again.
                  undoing = false;
                  report({ ok: false, code: 'error' });
                }
              })();
            },
          },
        );
        return true;
      } finally {
        inFlight.current.delete(tx.id);
      }
    },
    [categories, report, t, toast],
  );
}
