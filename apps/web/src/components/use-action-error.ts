'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { ActionFailure } from '@/server/actions/result';
import { useToast } from './ui/toast';

/** Service codes that have their own sentence under `actionErrors.detail`. */
const DETAIL_CODES: ReadonlySet<string> = new Set([
  'ai_not_eligible',
  'ai_depreciation_conflict',
  'date_in_future',
  'asset_already_disposed',
  'asset_archived',
  'asset_not_disposed',
  'sale_needs_amount',
  'sale_transaction_invalid',
  'sale_transaction_taken',
  'liability_not_linked',
  'liability_already_settled',
  'liability_not_settled',
  'card_cannot_link_asset',
  'asset_not_live',
  'account_already_linked',
  'asset_disposed',
]);

/** The `actionErrors` translator, loosened so the copy can take the failure's parameters. */
export type FailureT = (key: string, values?: Record<string, string | number>) => string;

/** The sentence for a failed action; the failure's parameters fill the copy's placeholders. */
export function failureText(t: FailureT, failure: ActionFailure): string {
  if (failure.code === 'forbidden') return t('forbidden');
  if (failure.code === 'validation') {
    const code = failure.detail?.code;
    if (code && DETAIL_CODES.has(code)) return t(`detail.${code}`);
    return t(`reason.${failure.reason}`, failure.detail?.params);
  }
  if (failure.code === 'conflict') return t(`conflict.${failure.conflict}`);
  return t('generic');
}

/** The user-facing sentence for a failed action: what happened, in the user's language. */
export function useFailureMessage(): (failure: ActionFailure) => string {
  const t = useTranslations('actionErrors') as unknown as FailureT;
  return useCallback((failure) => failureText(t, failure), [t]);
}

/** Shows a failed action as an error toast (403 included). */
export function useReportFailure(): (failure: ActionFailure) => void {
  const toast = useToast();
  const message = useFailureMessage();
  return useCallback((failure) => toast.error(message(failure)), [toast, message]);
}
