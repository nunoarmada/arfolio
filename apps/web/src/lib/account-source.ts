/** Where an account's movements come from, for its subtitle on the accounts list and page. */
export type AccountSource =
  { kind: 'synced'; at: string | null } | { kind: 'imported'; at: string } | { kind: 'manual' };

/**
 * A bank or broker link wins over file imports: a linked account is kept up to date by the
 * connection, so calling it "Manual" (or dating it by an old import) would be wrong.
 * `lastSyncAt` is the connection's last successful sync; null when it has not synced yet.
 */
export function accountSource(account: {
  connectionId: string | null;
  lastSyncAt: string | null;
  lastImportAt: string | null;
}): AccountSource {
  if (account.connectionId !== null) return { kind: 'synced', at: account.lastSyncAt };
  if (account.lastImportAt !== null) return { kind: 'imported', at: account.lastImportAt };
  return { kind: 'manual' };
}
