'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import {
  applyRuleAction,
  revertRuleApplicationAction,
  type RevertRuleResult,
} from '@/server/actions/rules';
import type { ActionFailure } from '@/server/actions/result';
import { useFailureMessage, useReportFailure } from '../use-action-error';
import { useToast, type ToastAction } from '../ui/toast';

export type ApplyOutcome = { ok: true; changed: number } | ActionFailure;

/**
 * Applies a rule to the existing movements and says so in a toast with "Anular" (6 s). The count
 * is the server's, not the preview's. Undo is one tap per toast: a second tap while the first is
 * running is ignored, and a transport failure lets the person try again. The caller decides what
 * a failure looks like (the dialog shows it in place, the offer toast as an error toast).
 */
export function useApplyRule() {
  const t = useTranslations('rules.apply');
  const transactions = useTranslations('transactions');
  const toast = useToast();
  const report = useReportFailure();
  const router = useRouter();

  const failure = useFailureMessage();

  // "Anular" for a token, one tap per toast. When the request itself fails the token is still
  // good until it expires, so the failure toast carries a fresh "Anular" to try again.
  const undoAction = useCallback(
    (token: string): ToastAction => {
      let undoing = false;
      const retry = () => toast.error(failure({ ok: false, code: 'error' }), undoAction(token));
      return {
        label: transactions('undo'),
        onClick: () => {
          if (undoing) return;
          undoing = true;
          void (async () => {
            try {
              const result = await revertRuleApplicationAction(token);
              if (!result.ok) {
                if (result.code === 'error') return retry();
                return report(result);
              }
              const data: RevertRuleResult = result.data;
              if (data.expired) toast.error(t('undoExpired'));
              else
                toast.success(
                  data.kept > 0 ? t('undonePartial', { kept: data.kept }) : t('undone'),
                );
              router.refresh();
            } catch {
              retry();
            }
          })();
        },
      };
    },
    [failure, report, router, t, toast, transactions],
  );

  return useCallback(
    async (ruleId: string, categoryName: string): Promise<ApplyOutcome> => {
      let result;
      try {
        result = await applyRuleAction(ruleId);
      } catch {
        return { ok: false, code: 'error' };
      }
      if (!result.ok) return result;
      const { changed, undoToken } = result.data;
      router.refresh();
      if (changed === 0 || !undoToken) return { ok: true, changed };
      toast.success(t('done', { count: changed, category: categoryName }), undoAction(undoToken));
      return { ok: true, changed };
    },
    [router, t, toast, undoAction],
  );
}
