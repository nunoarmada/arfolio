/**
 * Turns what `netWorthAt` returns into the rows of the Ativos and Passivos lists: one row per
 * account (a linked record gives its name, kind and page to its account's amount), records with
 * no value kept in the list, other-currency items tagged and left out of the subtotals.
 */

export type Side = 'asset' | 'liability';

/** The part of a `NetWorthLineItem` the lists need. */
export interface NwItem {
  side: Side;
  kind: string;
  /** Minor units, always positive. */
  amount: number;
  currency: string;
  source: 'account' | 'asset' | 'liability';
  refId: string;
  name: string;
  linked: boolean;
  viaAccountId: string | null;
  foreignCurrency: boolean;
  asOf: string | null;
  hasValue: boolean;
}

export interface AssetRecord {
  id: string;
  depreciationBpsPerYear: number | null;
  /** Only needed to name (and tell the state of) the asset a liability is linked to. */
  name?: string;
  archived?: boolean;
  /** Set once the asset was sold or written off. */
  disposedOn?: string | null;
  /** `sold` or `written_off`, with `disposedOn`. */
  disposalKind?: string | null;
}

export interface LiabilityRecord {
  id: string;
  principal: number | null;
  annualRateBps: number | null;
  termMonths: number | null;
  startDate: string | null;
  /** The asset this liability is linked to, if any. */
  assetId?: string | null;
}

export interface LatestRecord {
  refId: string;
  side: Side;
  asOf: string | null;
  value: number | null;
  source: string | null;
}

/** The one line under a row's name; the component turns it into words. */
export type Subtitle =
  | { kind: 'manual' | 'import' | 'connector' | 'ai'; asOf: string | null }
  | { kind: 'depreciation'; bps: number }
  | { kind: 'schedule' }
  | { kind: 'principal' }
  | { kind: 'account'; asOf: string | null }
  | { kind: 'via'; account: string; asOf: string | null }
  | { kind: 'noValue' };

export interface ItemRow {
  /**
   * Unique within the page (an account can appear more than once: its invested part, its cash
   * and a foreign position).
   */
  key: string;
  /** Id of the asset or liability (for the test id), or of the account. */
  refId: string;
  side: Side;
  kind: string;
  title: string;
  href: string;
  amount: number;
  currency: string;
  foreign: boolean;
  hasValue: boolean;
  subtitle: Subtitle;
  /** Asset rows only: the unsettled liabilities linked to it (absent when there are none). */
  linkedLiabilities?: LinkedLiability[];
  /** With `linkedLiabilities`: value minus their balances; null when a figure is missing or foreign. */
  equity?: number | null;
  /** Liability rows only: the asset it is linked to, and whether that asset is gone from the totals. */
  assetName?: string | null;
  assetSold?: boolean;
  /** With `assetSold`: the asset was written off rather than sold. */
  assetWrittenOff?: boolean;
  assetArchived?: boolean;
}

export interface LinkedLiability {
  refId: string;
  name: string;
  amount: number;
  hasValue: boolean;
  foreign: boolean;
}

export interface ItemGroup {
  kind: string;
  /** Household-currency total of the kind. */
  subtotal: number;
  rows: ItemRow[];
}

export const ASSET_GROUP_ORDER = ['real_estate', 'investment', 'cash', 'vehicle', 'other'] as const;
export const LIABILITY_GROUP_ORDER = ['mortgage', 'loan', 'card', 'debt', 'other'] as const;

const orderOf = (side: Side): readonly string[] =>
  side === 'asset' ? ASSET_GROUP_ORDER : LIABILITY_GROUP_ORDER;

function rank(side: Side, kind: string): number {
  const at = orderOf(side).indexOf(kind);
  return at === -1 ? orderOf(side).length : at;
}

function recordHref(side: Side, id: string): string {
  return side === 'asset' ? `/net-worth/assets/${id}` : `/net-worth/liabilities/${id}`;
}

const SOURCES = new Set(['manual', 'import', 'connector', 'ai']);

function valuationSubtitle(
  item: NwItem,
  latest: LatestRecord | undefined,
  asset: AssetRecord | undefined,
  liability: LiabilityRecord | undefined,
): Subtitle {
  if (!item.hasValue) return { kind: 'noValue' };
  if (item.side === 'asset') {
    if (asset?.depreciationBpsPerYear != null) {
      return { kind: 'depreciation', bps: asset.depreciationBpsPerYear };
    }
    const source = latest?.source ?? 'manual';
    return { kind: SOURCES.has(source) ? (source as 'manual') : 'manual', asOf: item.asOf };
  }
  if (item.asOf !== null) {
    const source = latest?.source ?? 'manual';
    if (source === 'schedule') return { kind: 'schedule' };
    return { kind: SOURCES.has(source) ? (source as 'manual') : 'manual', asOf: item.asOf };
  }
  const scheduled =
    liability &&
    liability.principal !== null &&
    liability.annualRateBps !== null &&
    liability.termMonths !== null &&
    liability.startDate !== null;
  return scheduled ? { kind: 'schedule' } : { kind: 'principal' };
}

function compare(a: ItemRow, b: ItemRow): number {
  if (a.foreign !== b.foreign) return a.foreign ? 1 : -1;
  if (a.hasValue !== b.hasValue) return a.hasValue ? -1 : 1;
  return b.amount - a.amount || a.title.localeCompare(b.title);
}

/**
 * The Ativos and Passivos groups. `byKind` is the household-currency total per `${side}:${kind}`
 * from the same `netWorthAt` call, so subtotals always agree with the headline.
 */
export function buildGroups(input: {
  items: readonly NwItem[];
  byKind: Readonly<Record<string, number>>;
  assets: readonly AssetRecord[];
  liabilities: readonly LiabilityRecord[];
  latest: readonly LatestRecord[];
  accountNames: ReadonlyMap<string, string>;
}): { assets: ItemGroup[]; liabilities: ItemGroup[] } {
  const assetById = new Map(input.assets.map((a) => [a.id, a]));
  const liabilityById = new Map(input.liabilities.map((l) => [l.id, l]));
  const latestById = new Map(input.latest.map((l) => [`${l.side}:${l.refId}`, l]));

  const accounts = input.items.filter((i) => i.source === 'account');
  const linked = input.items.filter((i) => i.linked);
  const plain = input.items.filter((i) => i.source !== 'account' && !i.linked);
  const claimed = new Set<string>();
  const rows: ItemRow[] = [];

  for (const account of accounts) {
    // A linked record lends the account its name and page: one of the account's own side first,
    // else any (an asset linked to an account that is overdrawn is counted as a liability).
    const record =
      linked.find(
        (l) => l.viaAccountId === account.refId && l.side === account.side && !claimed.has(l.refId),
      ) ?? linked.find((l) => l.viaAccountId === account.refId && !claimed.has(l.refId));
    // an investment account can appear twice in one currency: its invested part and its cash
    const key = `${account.source}:${account.refId}:${account.currency}:${account.side}:${account.kind}`;
    if (record) {
      claimed.add(record.refId);
      rows.push({
        key,
        refId: record.refId,
        side: account.side,
        // the services only rewrite the kind for a record on the account's own side
        kind: record.side === account.side ? record.kind : account.kind,
        title: record.name,
        href: recordHref(record.side, record.refId),
        amount: account.amount,
        currency: account.currency,
        foreign: account.foreignCurrency,
        hasValue: true,
        subtitle: { kind: 'via', account: account.name, asOf: account.asOf },
      });
      continue;
    }
    rows.push({
      key,
      refId: account.refId,
      side: account.side,
      kind: account.kind,
      title: account.name,
      href: `/accounts/${account.refId}`,
      amount: account.amount,
      currency: account.currency,
      foreign: account.foreignCurrency,
      hasValue: account.hasValue,
      subtitle: { kind: 'account', asOf: account.asOf },
    });
  }

  // Linked records whose account is not in the net worth: kept in the list, with no value.
  for (const record of linked) {
    if (claimed.has(record.refId)) continue;
    rows.push({
      key: `${record.source}:${record.refId}:${record.currency}:${record.side}`,
      refId: record.refId,
      side: record.side,
      kind: record.kind,
      title: record.name,
      href: recordHref(record.side, record.refId),
      amount: 0,
      currency: record.currency,
      foreign: record.foreignCurrency,
      hasValue: false,
      subtitle: {
        kind: 'via',
        account: input.accountNames.get(record.viaAccountId ?? '') ?? '',
        asOf: null,
      },
    });
  }

  for (const item of plain) {
    rows.push({
      key: `${item.source}:${item.refId}:${item.currency}:${item.side}`,
      refId: item.refId,
      side: item.side,
      kind: item.kind,
      title: item.name,
      href: recordHref(item.side, item.refId),
      amount: item.amount,
      currency: item.currency,
      foreign: item.foreignCurrency,
      hasValue: item.hasValue,
      subtitle: valuationSubtitle(
        item,
        latestById.get(`${item.side}:${item.refId}`),
        assetById.get(item.refId),
        liabilityById.get(item.refId),
      ),
    });
  }

  nestLinkedLiabilities(rows, liabilityById, assetById);

  const groupsOf = (side: Side): ItemGroup[] => {
    const kinds = [...new Set(rows.filter((r) => r.side === side).map((r) => r.kind))];
    kinds.sort((a, b) => rank(side, a) - rank(side, b) || a.localeCompare(b));
    return kinds.map((kind) => ({
      kind,
      subtotal: input.byKind[`${side}:${kind}`] ?? 0,
      rows: rows.filter((r) => r.side === side && r.kind === kind).sort(compare),
    }));
  };
  return { assets: groupsOf('asset'), liabilities: groupsOf('liability') };
}

/**
 * Ties linked liabilities to their asset rows. The liability rows stay where they are (the Passivos
 * total does not change); the asset row gains them plus the equity. A liability whose asset is not
 * a live row (sold, written off, archived) is only tagged, never nested.
 */
function nestLinkedLiabilities(
  rows: ItemRow[],
  liabilityById: ReadonlyMap<string, LiabilityRecord>,
  assetById: ReadonlyMap<string, AssetRecord>,
): void {
  const assetRows = new Map(rows.filter((r) => r.side === 'asset').map((r) => [r.refId, r]));
  const nested = new Map<string, ItemRow[]>();
  for (const row of rows) {
    if (row.side !== 'liability') continue;
    const assetId = liabilityById.get(row.refId)?.assetId;
    if (!assetId) continue;
    const target = assetById.get(assetId);
    row.assetName = target?.name ?? null;
    row.assetSold = target?.disposedOn != null;
    if (row.assetSold && target?.disposalKind === 'written_off') row.assetWrittenOff = true;
    if (target?.archived) row.assetArchived = true;
    if (!assetRows.has(assetId) || row.assetSold) continue;
    nested.set(assetId, [...(nested.get(assetId) ?? []), row]);
  }
  for (const [assetId, credits] of nested) {
    const asset = assetRows.get(assetId)!;
    credits.sort(compare);
    asset.linkedLiabilities = credits.map((c) => ({
      refId: c.refId,
      name: c.title,
      amount: c.amount,
      hasValue: c.hasValue,
      foreign: c.foreign,
    }));
    asset.equity = equityOf(asset, asset.linkedLiabilities);
  }
}

/**
 * An asset's value minus the balances of its linked unsettled liabilities. Null (shown as "—")
 * when the asset or any of them has no value or is in another currency.
 */
export function equityOf(
  asset: { amount: number; hasValue: boolean; foreign: boolean },
  credits: ReadonlyArray<{ amount: number; hasValue: boolean; foreign: boolean }>,
): number | null {
  const complete =
    asset.hasValue && !asset.foreign && credits.every((c) => c.hasValue && !c.foreign);
  return complete ? asset.amount - credits.reduce((sum, c) => sum + c.amount, 0) : null;
}

/**
 * What an account adds to net worth, for a record linked to it: the sum of its items on its own
 * side and in its own currency (an investment account can be two items, its invested part and its
 * cash; a position in another currency is not part of it). Null when the account is not counted.
 */
export function accountFigure(
  items: readonly NwItem[],
  accountId: string | null,
): { side: Side; amount: number; asOf: string | null } | null {
  if (accountId === null) return null;
  const parts = items.filter((i) => i.source === 'account' && i.refId === accountId);
  const first = parts[0];
  if (!first) return null;
  const own = parts.filter((i) => i.side === first.side && i.currency === first.currency);
  return {
    side: first.side,
    amount: own.reduce((sum, i) => sum + i.amount, 0),
    asOf: first.asOf,
  };
}
