'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  categoriseTransaction,
  ConflictError,
  undoAiCategorisation,
  createManualTransaction,
  deleteManualTransaction,
  dismissTransferHint,
  getTransaction,
  markTransfer,
  revertCategorisation,
  unlinkTransfer,
  updateTransaction,
  type ManualTransactionInput,
} from '@arfolio/services';
import { PERIODS, type Period } from '../../lib/transaction-filters';
import { getServiceCtx } from '../service-ctx';
import { toTxDto, type TxDto } from '../serialize';
import {
  loadReviewPage,
  loadTransactionsPage,
  loadTxExtras,
  txDtosFor,
  type ReviewPageDto,
  type TxExtras,
  type TxPageDto,
} from '../transactions-data';
import { run, type ActionFailure, type ActionResult } from './result';

const refreshCounts = () => revalidatePath('/', 'layout');

export async function loadTransactionsPageAction(
  query: string,
  cursor: string | null,
  defaultPeriod?: Period,
): Promise<ActionResult<TxPageDto>> {
  return run(async () =>
    loadTransactionsPage(
      await getServiceCtx(await headers()),
      query,
      cursor,
      PERIODS.includes(defaultPeriod as Period) ? defaultPeriod : undefined,
    ),
  );
}

export async function loadReviewPageAction(
  cursor: string | null,
): Promise<ActionResult<ReviewPageDto>> {
  return run(async () => loadReviewPage(await getServiceCtx(await headers()), cursor));
}

export async function getTransactionAction(id: string): Promise<ActionResult<TxDto>> {
  return run(async () => toTxDto(await getTransaction(await getServiceCtx(await headers()), id)));
}

export async function getTxExtrasAction(id: string): Promise<ActionResult<TxExtras>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    return loadTxExtras(ctx, await getTransaction(ctx, id));
  });
}

export interface CategoriseInput {
  id: string;
  categoryId: string;
  /** Make the merchant remember the choice and categorise its other open rows (default). */
  applyToMerchant?: boolean;
  /** Also save a rule that matches this merchant from now on. */
  createRule?: boolean;
}

export interface CategoriseDto {
  tx: TxDto;
  /** Other rows of the same merchant categorised by this change. */
  alsoApplied: number;
  /** Opaque id: hand back to `revertCategorisationAction` to undo exactly this change. */
  undoToken: string;
}

export async function categoriseAction(
  input: CategoriseInput,
): Promise<ActionResult<CategoriseDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const result = await categoriseTransaction(ctx, input);
    refreshCounts();
    return {
      tx: (await txDtosFor(ctx, [result.transaction]))[0]!,
      alsoApplied: result.alsoApplied,
      undoToken: result.undoToken,
    };
  });
}

export async function revertCategorisationAction(undoToken: string): Promise<ActionResult<TxDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const row = await revertCategorisation(ctx, undoToken);
    refreshCounts();
    return (await txDtosFor(ctx, [row]))[0]!;
  });
}

export async function saveNotesAction(id: string, notes: string): Promise<ActionResult<TxDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    return (await txDtosFor(ctx, [await updateTransaction(ctx, id, { notes })]))[0]!;
  });
}

export async function createManualTransactionAction(
  input: ManualTransactionInput,
): Promise<ActionResult<TxDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const row = await createManualTransaction(ctx, input);
    refreshCounts();
    return (await txDtosFor(ctx, [row]))[0]!;
  });
}

export async function deleteManualTransactionAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteManualTransaction(await getServiceCtx(await headers()), id);
    refreshCounts();
    return null;
  });
}

export async function markTransferAction(
  idA: string,
  idB: string,
): Promise<ActionResult<{ groupId: string }>> {
  return run(async () => {
    const groupId = await markTransfer(await getServiceCtx(await headers()), idA, idB);
    refreshCounts();
    return { groupId };
  });
}

export async function unlinkTransferAction(groupId: string): Promise<ActionResult> {
  return run(async () => {
    await unlinkTransfer(await getServiceCtx(await headers()), groupId);
    refreshCounts();
    return null;
  });
}

/** "This is not a transfer": the hint never returns (the legs can still be linked by hand). */
export async function dismissTransferHintAction(idA: string, idB: string): Promise<ActionResult> {
  return run(async () => {
    await dismissTransferHint(await getServiceCtx(await headers()), idA, idB);
    return null;
  });
}

/** `ai_changed`: the row was edited (or already undone) since the list was loaded. */
export type UndoAiResult =
  { ok: true; data: TxDto } | { ok: false; code: 'ai_changed' } | ActionFailure;

/** Sends an AI-categorised row back to review; its former category becomes the AI suggestion. */
export async function undoAiCategorisationAction(id: string): Promise<UndoAiResult> {
  const result = await run(async () => {
    try {
      const ctx = await getServiceCtx(await headers());
      const row = await undoAiCategorisation(ctx, id);
      refreshCounts();
      return (await txDtosFor(ctx, [row]))[0]!;
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'ai_categorisation_changed') {
        return 'ai_changed' as const;
      }
      throw error;
    }
  });
  if (!result.ok) return result;
  return result.data === 'ai_changed'
    ? { ok: false, code: 'ai_changed' }
    : { ok: true, data: result.data };
}
