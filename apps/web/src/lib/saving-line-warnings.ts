export interface SharedAccountWarning {
  /** `sharedPies`: pick pies to split the account; `sharedUnassigned`: no way to split. */
  key: 'sharedPies' | 'sharedUnassigned';
  line: string;
}

/**
 * Another saving line on the same account. A line with pies is traced through them, so it
 * never warns (even when the picker is hidden). Otherwise, on an investment account (`hasPicker`)
 * pies can split the account; elsewhere the money cannot be split. Null when there is
 * nothing to warn about.
 */
export function sharedAccountWarning(
  accountId: string,
  bucketIds: readonly string[],
  others: ReadonlyArray<{ name: string; kind: string; accountId: string | null }>,
  hasPicker: boolean,
): SharedAccountWarning | null {
  if (accountId === '') return null;
  if (bucketIds.length > 0) return null;
  const other = others.find((o) => o.kind === 'saving' && o.accountId === accountId);
  return other ? { key: hasPicker ? 'sharedPies' : 'sharedUnassigned', line: other.name } : null;
}
