import { merchantKey, type TransactionDetails } from '@arfolio/core';
import {
  findTransferCandidates,
  findTransferCandidatesFor,
  listTransactions,
  listReviewInbox,
  merchantFieldsFor,
  suggestRuleFromCorrection,
  ValidationError,
  type ServiceCtx,
  type TransactionDetail,
} from '@arfolio/services';
import { todayIn } from '../lib/dates';
import { parseFilters, resolveRange, type Period } from '../lib/transaction-filters';
import { loadHouseholdFormat } from './household-format';
import { toTxDto, type TxDto, type TxSource } from './serialize';

export const PAGE_SIZE = 50;

/**
 * DTOs for raw rows (what the write operations and transfer lookups return), with the merchant
 * and location looked up in one query so the UI does not lose them after an edit.
 */
export async function txDtosFor(ctx: ServiceCtx, rows: TxSource[]): Promise<TxDto[]> {
  const fields = await merchantFieldsFor(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    toTxDto({ ...r, ...(fields.get(r.id) ?? { merchant: null, location: null }) }),
  );
}

export interface TxPageDto {
  items: TxDto[];
  nextCursor: string | null;
}

/** One page of the main list for a filter query string (`?period=...`), newest first. */
export async function loadTransactionsPage(
  ctx: ServiceCtx,
  query: string,
  cursor: string | null,
  defaultPeriod?: Period,
): Promise<TxPageDto> {
  const filters = parseFilters(new URLSearchParams(query), defaultPeriod);
  const { timeZone } = await loadHouseholdFormat(ctx);
  const range = resolveRange(filters, todayIn(timeZone));
  const page = await listTransactions(ctx, {
    ...(filters.accountIds.length ? { accountIds: filters.accountIds } : {}),
    ...(filters.categoryIds.length ? { categoryIds: filters.categoryIds } : {}),
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
    ...(filters.q ? { search: filters.q } : {}),
    ...(filters.review ? { needsReview: true } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.pending ? { status: 'pending' as const } : {}),
    // Booked and pending cannot both hold: pending wins, which can only list pending rows.
    ...(filters.booked && !filters.pending ? { status: 'booked' as const } : {}),
    ...(filters.excludeTransfers ? { excludeTransfers: true } : {}),
    ...(filters.transfersOnly ? { transfersOnly: true } : {}),
    ...(filters.uncategorised ? { uncategorised: true } : {}),
    ...(filters.by === 'ai' ? { categorisedBy: 'ai' as const } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  });
  return { items: page.items.map(toTxDto), nextCursor: page.nextCursor };
}

export interface TransferHint {
  /** The single likely counterpart, or null when several rows could match. */
  partner: TxDto | null;
}

export interface ReviewPageDto extends TxPageDto {
  hints: Record<string, TransferHint>;
}

/** One page of the review inbox plus, per row, a possible transfer counterpart. */
export async function loadReviewPage(
  ctx: ServiceCtx,
  cursor: string | null,
): Promise<ReviewPageDto> {
  const page = await listReviewInbox(ctx, { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE });
  const items = page.items.map(toTxDto);
  return { items, nextCursor: page.nextCursor, hints: await transferHints(ctx, page.items) };
}

async function transferHints(
  ctx: ServiceCtx,
  rows: TxSource[],
): Promise<Record<string, TransferHint>> {
  const open = rows.filter((r) => r.transferGroupId === null && r.categoryId === null);
  // One set-based query for the whole page; locked rows never come back as hints.
  const found = await findTransferCandidatesFor(
    ctx,
    open.map((r) => r.id),
    { windowDays: 5, includeLocked: false },
  );
  const hints: Record<string, TransferHint> = {};
  const single = [...found.values()].flatMap((c) => (c.length === 1 ? c : []));
  const partners = new Map((await txDtosFor(ctx, single)).map((d) => [d.id, d]));
  for (const [id, candidates] of found) {
    if (candidates.length === 1) hints[id] = { partner: partners.get(candidates[0]!.id)! };
    else if (candidates.length > 1) hints[id] = { partner: null };
  }
  return hints;
}

export interface CategorySuggestion {
  categoryId: string;
  /** How many earlier movements of the same merchant used it. */
  uses: number;
}

export interface TransferLegDto {
  id: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  amount: number;
  currency: string;
  title: string;
}

export interface TxExtras {
  suggestions: CategorySuggestion[];
  /** The text a rule created from this correction would match ("CONTINENTE"). */
  ruleLabel: string | null;
  transferLeg: TransferLegDto | null;
  transferCandidates: TxDto[];
  /** What the provider reported beyond the columns (kept off the list DTO: it can be a few KB). */
  details: TransactionDetails | null;
}

/** What the detail sheet needs beyond the row: suggestions, rule label and transfer partners. */
export async function loadTxExtras(ctx: ServiceCtx, tx: TransactionDetail): Promise<TxExtras> {
  const term = tx.counterparty?.trim() || merchantKey(tx.rawDescription);
  const [similar, candidates, draft] = await Promise.all([
    term ? listTransactions(ctx, { search: term, limit: 100 }) : { items: [] },
    // A person picking the counterpart by hand may use legs that were locked against auto-pairing.
    tx.transferGroupId ? [] : findTransferCandidates(ctx, tx.id, { includeLocked: true }),
    // A row with no usable merchant text has no rule to suggest; anything else is a real failure.
    suggestRuleFromCorrection(ctx, tx.id).catch((error: unknown) => {
      if (error instanceof ValidationError) return null;
      throw error;
    }),
  ]);

  const counts = new Map<string, number>();
  for (const r of similar.items) {
    if (r.id === tx.id || !r.categoryId || r.transferGroupId) continue;
    counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
  }
  const suggestions = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([categoryId, uses]) => ({ categoryId, uses }));
  const partner = tx.transferPartner;
  return {
    suggestions,
    ruleLabel: draft?.name ?? null,
    transferLeg: partner
      ? {
          id: partner.id,
          accountId: partner.accountId,
          accountName: partner.accountName,
          bookingDate: partner.bookingDate,
          amount: partner.amount,
          currency: partner.currency,
          title: partner.counterparty?.trim() || partner.rawDescription,
        }
      : null,
    transferCandidates: await txDtosFor(ctx, candidates),
    details: tx.details,
  };
}

/** Categories the user picked most recently, newest first (the picker's "Recentes" group). */
export async function loadRecentCategoryIds(ctx: ServiceCtx, max = 6): Promise<string[]> {
  const page = await listTransactions(ctx, { limit: 100 });
  const seen = new Set<string>();
  for (const r of page.items) {
    if (r.categorisedBy === 'user' && r.categoryId && !r.transferGroupId) seen.add(r.categoryId);
    if (seen.size >= max) break;
  }
  return [...seen];
}
