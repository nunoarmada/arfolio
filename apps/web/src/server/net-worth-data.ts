import { parseAssetDetails, aiReadiness, type AiReadiness } from '@arfolio/core';
import {
  latestValues,
  listAccounts,
  listAssets,
  listAssetValuations,
  listLiabilities,
  listLiabilityBalances,
  netWorthAt,
  netWorthHistory,
  getTransaction,
  NotFoundError,
  scheduleFor,
  type Asset,
  type Liability,
  type ServiceCtx,
} from '@arfolio/services';
import type { schema } from '@arfolio/db';
import { notFound } from 'next/navigation';
import { monthStart, todayIn } from '../lib/dates';
import {
  accountFigure,
  buildGroups,
  equityOf,
  type ItemGroup,
  type LatestRecord,
  type NwItem,
} from '../lib/net-worth-items';
import {
  missingMonths,
  monthScale,
  placeRows,
  shiftMonth,
  type ChartRow,
} from '../lib/net-worth-chart';
import { remainingInstalments, type InstalmentRow } from '../lib/net-worth-schedule';
import { assertValidId } from '../lib/ids';
import {
  assetCurrent,
  changeFromRows,
  currentAiEstimate,
  liabilityCurrent,
  type AiEstimate,
  type BalanceCaption,
  type ChangeInfo,
  type CurrentAiEstimate,
} from '../lib/net-worth-derive';
import { linkableFor, type LinkSide } from '../lib/net-worth-links';
import { loadAiEnabled, loadHouseholdFormat } from './household-format';
import { toAccountDto, type AccountDto } from './serialize';

export type RangeKey = '12' | '24' | 'all';

export function parseRange(raw: string | string[] | undefined): RangeKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === '24' || value === 'all' ? value : '12';
}

/** The earliest month a range can reach (`all` reaches as far back as snapshots go). */
const ALL_FROM = '2000-01-01';

function rangeStart(range: RangeKey, currentMonth: string): string {
  return range === 'all' ? ALL_FROM : shiftMonth(currentMonth, range === '12' ? -11 : -23);
}

export type { ChangeInfo };

export type HistoryData =
  | {
      kind: 'ready';
      rows: ChartRow[];
      /** First month on the chart's scale and how many months it spans. */
      scale: { start: string; count: number };
      /** Past months after the first record that have no stored snapshot. */
      gaps: string[];
    }
  | { kind: 'error' };

/** An asset sold or written off, or a liability settled: no longer counted, listed for reference. */
export interface ExitedItem {
  side: 'asset' | 'liability';
  refId: string;
  name: string;
  kind: string;
  /** `yyyy-mm-dd` of the disposal or settlement. */
  date: string;
  disposalKind?: schema.DisposalKind;
  /** Minor units of `currency`; null for a sale entered without an amount (and for write-offs). */
  saleAmount?: number | null;
  currency: string;
}

/** Disposed assets and settled liabilities (archived ones stay hidden), newest first. */
function exitedItems(assets: readonly Asset[], liabilities: readonly Liability[]): ExitedItem[] {
  const out: ExitedItem[] = [];
  for (const a of assets) {
    if (a.archived || a.disposedOn === null || a.disposalKind === null) continue;
    out.push({
      side: 'asset',
      refId: a.id,
      name: a.name,
      kind: a.kind,
      date: a.disposedOn,
      disposalKind: a.disposalKind,
      saleAmount: a.saleAmount,
      currency: a.currency,
    });
  }
  for (const l of liabilities) {
    if (l.archived || l.settledOn === null) continue;
    out.push({
      side: 'liability',
      refId: l.id,
      name: l.name,
      kind: l.kind,
      date: l.settledOn,
      currency: l.currency,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

export type NetWorthPageData =
  | { kind: 'empty'; exited: ExitedItem[] }
  | {
      kind: 'ready';
      today: string;
      currentMonth: string;
      range: RangeKey;
      currency: string;
      net: number;
      assets: number;
      liabilities: number;
      change: ChangeInfo;
      groups: { assets: ItemGroup[]; liabilities: ItemGroup[] };
      /** The "Já não detidos" section: empty when nothing was sold, written off or settled. */
      exited: ExitedItem[];
      foreignCount: number;
      history: HistoryData;
      /** Past months the recalculate sheet offers, newest first, and the one it preselects. */
      recalcMonths: string[];
      recalcDefault: string;
    };

/** Everything the Resumo page renders; the history failing alone leaves the rest intact. */
export async function loadNetWorthPage(
  ctx: ServiceCtx,
  range: RangeKey,
): Promise<NetWorthPageData> {
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const today = todayIn(timeZone);
  const currentMonth = monthStart(today);
  const [nw, assets, liabilities, latest, accounts, history] = await Promise.all([
    netWorthAt(ctx, today),
    listAssets(ctx, { includeArchived: true, includeDisposed: true }),
    listLiabilities(ctx, { includeArchived: true, includeSettled: true }),
    latestValues(ctx, today),
    listAccounts(ctx, { includeArchived: true }),
    loadHistory(ctx, range, today, currentMonth),
  ]);
  const exited = exitedItems(assets, liabilities);
  if (nw.items.length === 0) return { kind: 'empty', exited };

  const groups = buildGroups({
    items: nw.items as NwItem[],
    byKind: nw.byKind,
    assets,
    liabilities,
    latest: latest as LatestRecord[],
    accountNames: new Map(accounts.map((a) => [a.id, a.name])),
  });

  const historyRows = history.kind === 'ready' ? history.rows : null;
  const earliest = history.kind === 'ready' ? history.rows[0]?.month : undefined;
  const lowest =
    range === 'all' && earliest && earliest < shiftMonth(currentMonth, -24)
      ? earliest
      : shiftMonth(currentMonth, -24);
  const recalcMonths: string[] = [];
  for (let m = shiftMonth(currentMonth, -1); m >= lowest; m = shiftMonth(m, -1))
    recalcMonths.push(m);
  const recalcDefault =
    (history.kind === 'ready' ? history.gaps.at(-1) : undefined) ?? recalcMonths[0]!;

  return {
    kind: 'ready',
    today,
    currentMonth,
    range,
    currency,
    net: nw.net,
    assets: nw.assets,
    liabilities: nw.liabilities,
    change: changeFromRows(historyRows),
    groups,
    exited,
    foreignCount: nw.foreign.length,
    history,
    recalcMonths,
    recalcDefault,
  };
}

async function loadHistory(
  ctx: ServiceCtx,
  range: RangeKey,
  today: string,
  currentMonth: string,
): Promise<HistoryData> {
  try {
    const start = rangeStart(range, currentMonth);
    const rows = await netWorthHistory(ctx, { from: start, to: today });
    const scale = monthScale(rows, start, currentMonth);
    return { kind: 'ready', rows, scale, gaps: missingMonths(placeRows(rows, scale), scale) };
  } catch (error) {
    console.error(`net worth history failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return { kind: 'error' };
  }
}

export type HomeNetWorth =
  | {
      kind: 'ready';
      net: number;
      currency: string;
      change: ChangeInfo;
      /** The last 12 months of the history already fetched, for the sparkline. */
      rows: ChartRow[];
      scale: { start: string; count: number };
      /** Items counted in net worth (accounts, assets, liabilities): none means nothing to show. */
      itemCount: number;
      /** Items in another currency, left out of the total (named, never converted). */
      foreignCount: number;
    }
  | { kind: 'error' };

/** The net worth and its monthly change for the home card; a failure is reported, never thrown. */
export async function loadHomeNetWorth(ctx: ServiceCtx): Promise<HomeNetWorth> {
  try {
    const { timeZone, currency } = await loadHouseholdFormat(ctx);
    const today = todayIn(timeZone);
    // The same baseline as Resumo: the latest earlier month that has a record.
    const [rows, nw] = await Promise.all([
      netWorthHistory(ctx, { from: ALL_FROM, to: today }),
      netWorthAt(ctx, today),
    ]);
    const net = nw.net;
    const currentMonth = monthStart(today);
    const from = shiftMonth(currentMonth, -11);
    return {
      kind: 'ready',
      net,
      currency,
      change: changeFromRows(rows),
      // Same query, sliced: the sparkline needs no second trip to the database.
      rows: rows.filter((r) => r.month >= from),
      scale: monthScale(rows, from, currentMonth),
      itemCount: nw.items.length,
      foreignCount: nw.foreign.length,
    };
  } catch (error) {
    console.error(`home net worth failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return { kind: 'error' };
  }
}

// ---------------------------------------------------------------------------------------------
// Detail pages

export interface HistoryEntryDto {
  id: string;
  asOf: string;
  /** Minor units of the record's own currency. */
  amount: number;
  /** manual, import, connector, ai, depreciation or schedule. */
  method: string;
  /** For an `ai` row, the model's rationale. */
  note: string | null;
  /** Only AI valuations carry a range and sources. */
  estimate: AiEstimate | null;
}

export interface AssetDetailDto {
  id: string;
  name: string;
  kind: string;
  notes: string | null;
  currency: string;
  foreign: boolean;
  accountId: string | null;
  accountName: string | null;
  depreciationBps: number | null;
  /** The kind-specific details that pass their schema; empty when none were stored or valid. */
  details: Record<string, unknown>;
  aiValuation: boolean;
  /** ISO timestamp of a pending estimate request (the job has not answered it yet). */
  aiRequestedAt: string | null;
  /** insufficient_data, no_answer or api_error: why the last attempt gave nothing. */
  aiLastError: string | null;
  /** Set once the asset was sold or written off. */
  disposal: AssetDisposalDto | null;
}

export interface AssetDisposalDto {
  kind: schema.DisposalKind;
  /** `yyyy-mm-dd`: the asset stopped counting that day. */
  date: string;
  /** Minor units of the asset's currency; null for a write-off. */
  saleAmount: number | null;
  /** The transaction the sale was recorded with; null for a sale entered by hand. */
  saleTransaction: SaleTransactionDto | null;
}

export interface SaleTransactionDto {
  id: string;
  bookingDate: string;
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
  accountId: string;
  accountName: string | null;
  description: string;
}

/** A liability linked to the asset, with what is owed today. */
export interface LinkedLiabilityDto {
  id: string;
  name: string;
  kind: string;
  /** Minor units of `currency`. */
  amount: number;
  hasValue: boolean;
  currency: string;
  foreign: boolean;
  asOf: string | null;
}

export interface AssetDetail {
  asset: AssetDetailDto;
  entries: HistoryEntryDto[];
  /** Whether the stored details are enough for an AI estimate, and what is still missing. */
  readiness: AiReadiness;
  /** The household's AI switch; AI valuation only runs when it is on. */
  householdAiEnabled: boolean;
  /** The AI estimate behind the current value, when it is the newest real valuation. */
  aiEstimate: CurrentAiEstimate | null;
  today: string;
  current: { hasValue: boolean; amount: number; asOf: string | null; method: string | null };
  /** The valuation a depreciating asset's estimate starts from. */
  estimateFrom: { amount: number; asOf: string } | null;
  /** A disposed asset: the newest valuation dated before the disposal ("Último valor antes da venda"). */
  lastValueBefore: HistoryEntryDto | null;
  /** Unsettled liabilities linked to this asset, largest balance first. */
  linkedLiabilities: LinkedLiabilityDto[];
  /** How many linked liabilities are already settled. */
  settledLinkedCount: number;
  /** Value minus linked balances (household currency only); null shown as "—", and absent with no links. */
  equity: number | null;
}

/** A record that vanished (or never existed) is a 404, not a failure. */
const orNotFound = <T>(promise: Promise<T>): Promise<T> =>
  promise.catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

const findOrNotFound = <T extends { id: string; archived: boolean }>(
  rows: readonly T[],
  id: string,
): T => {
  const found = rows.find((r) => r.id === id);
  if (!found || found.archived) notFound();
  return found;
};

export async function loadAssetDetail(ctx: ServiceCtx, id: string): Promise<AssetDetail> {
  assertValidId(id);
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const today = todayIn(timeZone);
  const [assets, valuations, nw, accounts, householdAiEnabled, liabilities] = await Promise.all([
    listAssets(ctx, { includeArchived: true, includeDisposed: true }),
    orNotFound(listAssetValuations(ctx, id)),
    netWorthAt(ctx, today),
    listAccounts(ctx, { includeArchived: true }),
    loadAiEnabled(ctx),
    listLiabilities(ctx, { includeSettled: true }),
  ]);
  const asset = findOrNotFound(assets, id);
  const entries = valuations.map((v) => ({
    id: v.id,
    asOf: v.asOf,
    amount: v.value,
    method: v.method,
    note: v.note,
    estimate: v.estimate ?? null,
  }));
  const figure = (accountId: string | null) => accountFigure(nw.items as NwItem[], accountId);
  const { current, estimateFrom } = assetCurrent({
    accountId: asset.accountId,
    accountItem: figure(asset.accountId),
    item: nw.items.find((i) => i.source === 'asset' && i.refId === id),
    entries,
    today,
    depreciationBps: asset.depreciationBpsPerYear,
  });
  const accountDtos = accounts.map(toAccountDto);
  const linked = liabilities.filter((l) => l.assetId === id);
  const linkedLiabilities = linked
    .filter((l) => l.settledOn === null)
    .map((l) => linkedLiabilityDto(l, nw.items, currency))
    .sort(
      (a, b) =>
        Number(b.hasValue) - Number(a.hasValue) ||
        b.amount - a.amount ||
        a.name.localeCompare(b.name),
    );
  const assetFigure = {
    amount: current.amount,
    hasValue: current.hasValue,
    foreign: asset.currency !== currency,
  };
  const disposal = await disposalDto(ctx, asset, accountDtos);
  return {
    asset: { ...toAssetDto(asset, accountDtos, currency), disposal },
    entries,
    readiness: aiReadiness(asset.kind, asset.details),
    householdAiEnabled,
    aiEstimate: currentAiEstimate({ entries, today }),
    today,
    current,
    estimateFrom,
    lastValueBefore: asset.disposedOn
      ? (entries.find((e) => e.asOf < asset.disposedOn!) ?? null)
      : null,
    linkedLiabilities,
    settledLinkedCount: linked.length - linkedLiabilities.length,
    equity:
      asset.disposedOn || linkedLiabilities.length === 0
        ? null
        : equityOf(
            assetFigure,
            linkedLiabilities.map((l) => ({ ...l })),
          ),
  };
}

/** What a linked liability owes today, read from the same net-worth lines the lists use. */
function linkedLiabilityDto(
  l: Liability,
  items: ReadonlyArray<{
    source: string;
    refId: string;
    side: string;
    amount: number;
    asOf: string | null;
    hasValue: boolean;
  }>,
  householdCurrency: string,
): LinkedLiabilityDto {
  // A liability tied to an account owes that account's balance; otherwise its own line.
  const line = l.accountId
    ? items.find((i) => i.source === 'account' && i.refId === l.accountId && i.side === 'liability')
    : items.find((i) => i.source === 'liability' && i.refId === l.id);
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    amount: line?.hasValue ? line.amount : 0,
    hasValue: line?.hasValue ?? false,
    currency: l.currency,
    foreign: l.currency !== householdCurrency,
    asOf: line?.asOf ?? null,
  };
}

/** The disposal of a sold or written-off asset, with the sale's transaction when there is one. */
async function disposalDto(
  ctx: ServiceCtx,
  asset: Asset,
  accounts: readonly AccountDto[],
): Promise<AssetDisposalDto | null> {
  if (asset.disposedOn === null || asset.disposalKind === null) return null;
  let saleTransaction: SaleTransactionDto | null = null;
  if (asset.saleTransactionId) {
    try {
      const t = await getTransaction(ctx, asset.saleTransactionId);
      saleTransaction = {
        id: t.id,
        bookingDate: t.bookingDate,
        amount: t.amount,
        currency: t.currency,
        accountId: t.accountId,
        accountName: accounts.find((a) => a.id === t.accountId)?.name ?? null,
        description: t.counterparty ?? t.rawDescription,
      };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return {
    kind: asset.disposalKind,
    date: asset.disposedOn,
    saleAmount: asset.saleAmount,
    saleTransaction,
  };
}

function toAssetDto(
  asset: Asset,
  accounts: AccountDto[],
  householdCurrency: string,
): Omit<AssetDetailDto, 'disposal'> {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    notes: asset.notes,
    currency: asset.currency,
    foreign: asset.currency !== householdCurrency,
    accountId: asset.accountId,
    accountName: accounts.find((a) => a.id === asset.accountId)?.name ?? null,
    depreciationBps: asset.depreciationBpsPerYear,
    details: { ...parseAssetDetails(asset.kind, asset.details) },
    aiValuation: asset.aiValuation,
    aiRequestedAt: asset.aiRequestedAt?.toISOString() ?? null,
    aiLastError: asset.aiLastError,
  };
}

export interface LiabilityDetailDto {
  id: string;
  name: string;
  kind: string;
  notes: string | null;
  currency: string;
  foreign: boolean;
  accountId: string | null;
  accountName: string | null;
  assetId: string | null;
  assetName: string | null;
  /** When the linked asset was sold or written off: how and when (the credit is not settled by it). */
  assetDisposal: { kind: schema.DisposalKind; date: string } | null;
  assetArchived: boolean;
  /** `yyyy-mm-dd` when the liability was settled, else null. */
  settledOn: string | null;
  principal: number | null;
  annualRateBps: number | null;
  termMonths: number | null;
  startDate: string | null;
}

export type { BalanceCaption };

export interface ScheduleDto {
  payment: number;
  principal: number;
  annualRateBps: number;
  termMonths: number;
  startDate: string;
  /** Instalments still to pay, and the date of the last one. */
  remaining: number;
  endDate: string;
  /** What the plan says is owed today. */
  planBalance: number;
  rows: InstalmentRow[];
}

export interface LiabilityDetail {
  liability: LiabilityDetailDto;
  entries: HistoryEntryDto[];
  today: string;
  current: { hasValue: boolean; amount: number; caption: BalanceCaption };
  schedule: ScheduleDto | null;
  /** A recorded balance that has drifted from the plan, if any. */
  divergence: { real: number; plan: number } | null;
  /** A settled liability: the newest balance recorded on or before the settlement ("Último saldo"). */
  lastBalance: HistoryEntryDto | null;
}

export async function loadLiabilityDetail(ctx: ServiceCtx, id: string): Promise<LiabilityDetail> {
  assertValidId(id);
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const today = todayIn(timeZone);
  const [liabilities, balances, nw, accounts, assets, schedule] = await Promise.all([
    listLiabilities(ctx, { includeArchived: true, includeSettled: true }),
    orNotFound(listLiabilityBalances(ctx, id)),
    netWorthAt(ctx, today),
    listAccounts(ctx, { includeArchived: true }),
    listAssets(ctx, { includeArchived: true, includeDisposed: true }),
    orNotFound(scheduleFor(ctx, id)),
  ]);
  const liability = findOrNotFound(liabilities, id);
  const entries = balances.map((b) => ({
    id: b.id,
    asOf: b.asOf,
    amount: b.balance,
    method: b.source,
    note: b.note,
    estimate: null,
  }));

  const sched: ScheduleDto | null = schedule
    ? {
        payment: schedule.payment,
        principal: schedule.params.principal,
        annualRateBps: schedule.params.annualRateBps,
        termMonths: schedule.params.termMonths,
        startDate: schedule.params.startDate,
        remaining: remainingInstalments(schedule.rows, today),
        endDate: schedule.rows.at(-1)!.date,
        planBalance:
          schedule.rows.filter((r) => r.date <= today).at(-1)?.balance ?? schedule.params.principal,
        rows: schedule.rows,
      }
    : null;
  const account = accountFigure(nw.items as NwItem[], liability.accountId);
  const { current, divergence } = liabilityCurrent({
    accountId: liability.accountId,
    accountItem: account,
    item: nw.items.find((i) => i.source === 'liability' && i.refId === id),
    entries,
    today,
    plan: sched,
  });

  const linkedAsset = assets.find((a) => a.id === liability.assetId);
  return {
    liability: {
      id: liability.id,
      name: liability.name,
      kind: liability.kind,
      notes: liability.notes,
      currency: liability.currency,
      foreign: liability.currency !== currency,
      accountId: liability.accountId,
      accountName: accounts.find((a) => a.id === liability.accountId)?.name ?? null,
      assetId: liability.assetId,
      assetName: linkedAsset?.name ?? null,
      assetDisposal:
        linkedAsset?.disposedOn && linkedAsset.disposalKind
          ? { kind: linkedAsset.disposalKind, date: linkedAsset.disposedOn }
          : null,
      assetArchived: linkedAsset?.archived ?? false,
      settledOn: liability.settledOn,
      principal: liability.principal,
      annualRateBps: liability.annualRateBps,
      termMonths: liability.termMonths,
      startDate: liability.startDate,
    },
    entries,
    today,
    current,
    schedule: sched,
    divergence,
    lastBalance: liability.settledOn
      ? (entries.find((e) => e.asOf <= liability.settledOn!) ?? null)
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Forms

export interface AccountOption {
  id: string;
  name: string;
  /** Only set on properties: archived but still the one linked. */
  archived?: boolean;
}

export interface AssetFormData {
  today: string;
  currency: string;
  accounts: AccountOption[];
  /** The household's AI switch: without it the form offers AI valuation disabled. */
  aiEnabled: boolean;
  asset: {
    id: string;
    kind: string;
    name: string;
    notes: string | null;
    currency: string;
    accountId: string | null;
    depreciationBps: number | null;
    details: Record<string, unknown>;
    aiValuation: boolean;
  } | null;
}

/**
 * The accounts a record on `side` can be linked to (see linkableFor): counted in net worth, on its
 * side, not already counted by another live record; plus the one it is linked to now.
 */
function linkableAccounts(
  side: LinkSide,
  all: AccountDto[],
  records: { asset: Asset[]; liability: Liability[] },
  self: { id: string; accountId: string | null } | null,
): AccountOption[] {
  const claimed = new Set<string>();
  for (const recordSide of ['asset', 'liability'] as const) {
    for (const r of records[recordSide]) {
      const isSelf = recordSide === side && r.id === self?.id;
      // A sold or settled record no longer counts its account.
      const gone = 'disposedOn' in r ? r.disposedOn !== null : r.settledOn !== null;
      if (r.accountId && !r.archived && !gone && !isSelf) claimed.add(r.accountId);
    }
  }
  return linkableFor(
    side,
    all.map((a) => ({ ...a, balance: a.balance ?? 0 })),
    { current: self?.accountId ?? null, claimed },
  );
}

export async function loadAssetForm(ctx: ServiceCtx, id: string | null): Promise<AssetFormData> {
  if (id) assertValidId(id);
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const [accounts, assets, liabilities, aiEnabled] = await Promise.all([
    listAccounts(ctx, { includeArchived: true }),
    listAssets(ctx, { includeArchived: true, includeDisposed: true }),
    listLiabilities(ctx),
    loadAiEnabled(ctx),
  ]);
  const found = id ? findOrNotFound(assets, id) : null;
  return {
    today: todayIn(timeZone),
    currency,
    aiEnabled,
    accounts: linkableAccounts(
      'asset',
      accounts.map(toAccountDto),
      { asset: assets, liability: liabilities },
      found,
    ),
    asset: found && {
      id: found.id,
      kind: found.kind,
      name: found.name,
      notes: found.notes,
      currency: found.currency,
      accountId: found.accountId,
      depreciationBps: found.depreciationBpsPerYear,
      details: { ...parseAssetDetails(found.kind, found.details) },
      aiValuation: found.aiValuation,
    },
  };
}

export interface AssetOption extends AccountOption {
  kind: string;
  /** Set when the linked asset has since been sold or written off. */
  disposalKind: schema.DisposalKind | null;
}

export interface LiabilityFormData {
  today: string;
  currency: string;
  accounts: AccountOption[];
  /** Live assets of every kind a credit can be linked to, plus the one it is linked to now. */
  assetOptions: AssetOption[];
  liability: {
    id: string;
    kind: string;
    name: string;
    notes: string | null;
    currency: string;
    accountId: string | null;
    assetId: string | null;
    principal: number | null;
    annualRateBps: number | null;
    termMonths: number | null;
    startDate: string | null;
  } | null;
}

export async function loadLiabilityForm(
  ctx: ServiceCtx,
  id: string | null,
): Promise<LiabilityFormData> {
  if (id) assertValidId(id);
  const { timeZone, currency } = await loadHouseholdFormat(ctx);
  const [accounts, assets, liabilities] = await Promise.all([
    listAccounts(ctx, { includeArchived: true }),
    listAssets(ctx, { includeArchived: true, includeDisposed: true }),
    listLiabilities(ctx, { includeArchived: true, includeSettled: true }),
  ]);
  const found = id ? findOrNotFound(liabilities, id) : null;
  return {
    today: todayIn(timeZone),
    currency,
    accounts: linkableAccounts(
      'liability',
      accounts.map(toAccountDto),
      { asset: assets, liability: liabilities },
      found,
    ),
    assetOptions: assets
      .filter((a) => (!a.archived && a.disposedOn === null) || a.id === found?.assetId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        archived: a.archived,
        disposalKind: a.disposedOn === null ? null : a.disposalKind,
      })),
    liability: found && {
      id: found.id,
      kind: found.kind,
      name: found.name,
      notes: found.notes,
      currency: found.currency,
      accountId: found.accountId,
      assetId: found.assetId,
      principal: found.principal,
      annualRateBps: found.annualRateBps,
      termMonths: found.termMonths,
      startDate: found.startDate,
    },
  };
}
