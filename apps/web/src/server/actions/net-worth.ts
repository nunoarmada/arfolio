'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  addAssetValuation,
  addLiabilityBalance,
  createAsset,
  createLiability,
  deleteAsset,
  deleteAssetValuation,
  deleteLiability,
  deleteLiabilityBalance,
  disposeAsset,
  listSaleCandidates,
  recalculateNetWorthSnapshot,
  requestAssetEstimate,
  settleLiability,
  undoAssetDisposal,
  unsettleLiability,
  updateAsset,
  updateLiability,
  type DisposeAssetInput,
  type SaleCandidate,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionFailure, type ActionResult } from './result';

/** Longest sale-candidate search the service accepts; a longer one is cut, not refused. */
const SALE_SEARCH_MAX_LENGTH = 200;

const refresh = () => revalidatePath('/', 'layout');

export interface ValueInput {
  /** `yyyy-mm-dd`. */
  asOf: string;
  /** Minor units of the record's currency. */
  amount: number;
}

export interface ScheduleInput {
  principal: number;
  annualRateBps: number;
  termMonths: number;
  startDate: string;
}

export interface AssetInput {
  kind: 'real_estate' | 'vehicle' | 'investment' | 'cash' | 'other';
  name: string;
  notes: string | null;
  accountId: string | null;
  depreciationBps: number | null;
  /** Kind-specific details (empty fields already left out); null for none. */
  details: Record<string, string | number | boolean> | null;
  aiValuation: boolean;
}

export interface LiabilityInput {
  kind: 'mortgage' | 'loan' | 'debt' | 'card' | 'other';
  name: string;
  notes: string | null;
  accountId: string | null;
  assetId: string | null;
  /** All four together, or null when the liability has no plan. */
  schedule: ScheduleInput | null;
}

const scheduleFields = (schedule: ScheduleInput | null) => ({
  principal: schedule?.principal ?? null,
  annualRateBps: schedule?.annualRateBps ?? null,
  termMonths: schedule?.termMonths ?? null,
  startDate: schedule?.startDate ?? null,
});

/** Only vehicles depreciate, and an asset valued by AI has no rate (the service refuses both). */
const depreciationFor = (input: AssetInput) =>
  input.kind === 'vehicle' && !input.aiValuation ? input.depreciationBps : null;

/**
 * Creates an asset and, when a first value is given, records it. The two steps are separate
 * writes: if the value fails the asset still exists and `valueFailure` says why, so the page can
 * open it and offer "Atualizar valor" instead of creating a duplicate.
 */
export async function createAssetAction(
  input: AssetInput & { currency: string; initial: ValueInput | null },
): Promise<ActionResult<{ id: string; valueFailure: ActionFailure | null }>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const created = await createAsset(ctx, {
      kind: input.kind,
      name: input.name,
      notes: input.notes,
      accountId: input.accountId,
      currency: input.currency,
      depreciationBpsPerYear: depreciationFor(input),
      details: input.details,
      aiValuation: input.aiValuation,
    });
    let valueFailure: ActionFailure | null = null;
    if (input.initial && !input.accountId) {
      const initial = input.initial;
      const saved = await run(() =>
        addAssetValuation(ctx, created.id, { asOf: initial.asOf, value: initial.amount }),
      );
      if (!saved.ok) valueFailure = saved;
    }
    refresh();
    return { id: created.id, valueFailure };
  });
}

export async function updateAssetAction(
  id: string,
  input: AssetInput,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const row = await updateAsset(await getServiceCtx(await headers()), id, {
      kind: input.kind,
      name: input.name,
      notes: input.notes,
      accountId: input.accountId,
      depreciationBpsPerYear: depreciationFor(input),
      details: input.details,
      aiValuation: input.aiValuation,
    });
    refresh();
    return { id: row.id };
  });
}

/** "Estimar agora": asks for a fresh AI estimate; the worker picks it up within minutes. */
export async function requestAssetEstimateAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await requestAssetEstimate(await getServiceCtx(await headers()), id);
    refresh();
    return null;
  });
}

/**
 * Sells or writes off an asset (see `disposeAsset`): a sale is a date and amount or a transaction;
 * `settle` lists linked liabilities that end with it, settled in the same transaction.
 */
export async function disposeAssetAction(
  id: string,
  input: DisposeAssetInput,
): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await disposeAsset(ctx, id, input);
    refresh();
    return null;
  });
}

export async function undoAssetDisposalAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await undoAssetDisposal(ctx, id);
    refresh();
    return null;
  });
}

/** Owner only (the service refuses anyone else). Linked liabilities stay, unlinked. */
export async function deleteAssetAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await deleteAsset(ctx, id);
    refresh();
    return null;
  });
}

/** Incoming transactions that could record the asset's sale, newest first (a read: any role). */
export async function searchSaleCandidatesAction(
  assetId: string,
  search: string,
  limit?: number,
): Promise<ActionResult<SaleCandidate[]>> {
  return run(async () =>
    listSaleCandidates(await getServiceCtx(await headers()), assetId, {
      search: typeof search === 'string' ? search.slice(0, SALE_SEARCH_MAX_LENGTH) : undefined,
      limit,
    }),
  );
}

export async function addAssetValuationAction(
  assetId: string,
  input: ValueInput & { note: string | null },
): Promise<ActionResult> {
  return run(async () => {
    await addAssetValuation(await getServiceCtx(await headers()), assetId, {
      asOf: input.asOf,
      value: input.amount,
      note: input.note,
    });
    refresh();
    return null;
  });
}

export async function deleteAssetValuationAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteAssetValuation(await getServiceCtx(await headers()), id);
    refresh();
    return null;
  });
}

/** Creates a liability with its plan (when given) and, when a first balance is given, records it. */
export async function createLiabilityAction(
  input: LiabilityInput & { currency: string; initial: ValueInput | null },
): Promise<ActionResult<{ id: string; valueFailure: ActionFailure | null }>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const created = await createLiability(ctx, {
      kind: input.kind,
      name: input.name,
      notes: input.notes,
      accountId: input.accountId,
      assetId: input.kind === 'card' ? null : input.assetId,
      currency: input.currency,
      ...scheduleFields(input.schedule),
    });
    let valueFailure: ActionFailure | null = null;
    if (input.initial && !input.accountId) {
      const initial = input.initial;
      const saved = await run(() =>
        addLiabilityBalance(ctx, created.id, { asOf: initial.asOf, balance: initial.amount }),
      );
      if (!saved.ok) valueFailure = saved;
    }
    refresh();
    return { id: created.id, valueFailure };
  });
}

export async function updateLiabilityAction(
  id: string,
  input: LiabilityInput,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const row = await updateLiability(await getServiceCtx(await headers()), id, {
      kind: input.kind,
      name: input.name,
      notes: input.notes,
      accountId: input.accountId,
      assetId: input.kind === 'card' ? null : input.assetId,
      ...scheduleFields(input.schedule),
    });
    refresh();
    return { id: row.id };
  });
}

export async function addLiabilityBalanceAction(
  liabilityId: string,
  input: ValueInput & { note: string | null },
): Promise<ActionResult> {
  return run(async () => {
    await addLiabilityBalance(await getServiceCtx(await headers()), liabilityId, {
      asOf: input.asOf,
      balance: input.amount,
      note: input.note,
    });
    refresh();
    return null;
  });
}

export async function deleteLiabilityBalanceAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteLiabilityBalance(await getServiceCtx(await headers()), id);
    refresh();
    return null;
  });
}

export async function settleLiabilityAction(
  id: string,
  input: { date: string },
): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await settleLiability(ctx, id, input);
    refresh();
    return null;
  });
}

export async function unsettleLiabilityAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await unsettleLiability(ctx, id);
    refresh();
    return null;
  });
}

/** Owner only (the service refuses anyone else). */
export async function deleteLiabilityAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await deleteLiability(ctx, id);
    refresh();
    return null;
  });
}

/** "Recalcular um mês": stores the net worth of a past month again from today's data. */
export async function recalculateNetWorthAction(month: string): Promise<ActionResult> {
  return run(async () => {
    await recalculateNetWorthSnapshot(await getServiceCtx(await headers()), month);
    refresh();
    return null;
  });
}
