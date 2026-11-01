export interface NetWorthItem {
  side: 'asset' | 'liability';
  kind: string;
  /** Minor units, always positive (a liability is the amount owed). */
  amount: number;
  currency: string;
}

export interface NetWorthComposition<T extends NetWorthItem = NetWorthItem> {
  assets: number;
  liabilities: number;
  /** assets - liabilities */
  net: number;
  /** Household-currency totals keyed `${side}:${kind}`, e.g. `asset:cash`, `liability:mortgage`. */
  byKind: Record<string, number>;
  /** Items in another currency: not summed anywhere (no FX), returned as given. */
  foreign: T[];
}

/** Sums household-currency items into assets, liabilities and net; foreign items are only listed. */
export function composeNetWorth<T extends NetWorthItem>(
  items: readonly T[],
  householdCurrency: string,
): NetWorthComposition<T> {
  let assets = 0;
  let liabilities = 0;
  const byKind: Record<string, number> = {};
  const foreign: T[] = [];
  for (const item of items) {
    if (item.currency !== householdCurrency) {
      foreign.push(item);
      continue;
    }
    if (item.side === 'asset') assets += item.amount;
    else liabilities += item.amount;
    const key = `${item.side}:${item.kind}`;
    byKind[key] = (byKind[key] ?? 0) + item.amount;
  }
  return { assets, liabilities, net: assets - liabilities, byKind, foreign };
}
