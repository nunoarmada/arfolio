/**
 * Whether the home page is replaced by the "add your first account" state: no accounts, and no
 * assets or liabilities counted in net worth either (a household that only tracks a house or a
 * loan still has a dashboard). A net worth that failed to load does not keep the empty state
 * from showing, nor does a failed account list force it.
 */
export function isHomeEmpty(
  accounts: { kind: 'ready'; count: number } | { kind: 'error' },
  netWorth: { kind: 'ready'; itemCount: number } | { kind: 'error' },
): boolean {
  if (accounts.kind !== 'ready' || accounts.count > 0) return false;
  return netWorth.kind !== 'ready' || netWorth.itemCount === 0;
}
