/** The pure rules of the link step: defaults, validation and the payload for the service. */

export interface LinkOption {
  externalKey: string;
  name: string;
  ibanLast4?: string;
  currency: string;
  stableKey: boolean;
  /** The account this provider account is linked to now, if any. */
  accountId: string | null;
}

export interface LinkableAccount {
  id: string;
  name: string;
  currency: string;
  ibanLast4: string | null;
  archived: boolean;
  connectionId: string | null;
}

export type LinkMode = 'create' | 'existing' | 'ignore';

export interface LinkRow {
  externalKey: string;
  mode: LinkMode;
  name: string;
  type: string;
  accountId: string;
  /** Already linked (renewal): shown read-only until "Alterar". */
  linkedTo: string | null;
  changing: boolean;
}

/** Accounts a provider account may be linked to: same currency, not archived, not linked elsewhere. */
export function linkableAccounts(
  option: Pick<LinkOption, 'currency'>,
  accounts: LinkableAccount[],
  connectionId: string,
): LinkableAccount[] {
  return accounts.filter(
    (a) =>
      !a.archived &&
      a.currency === option.currency &&
      (a.connectionId === null || a.connectionId === connectionId),
  );
}

/**
 * The one existing account that obviously is this provider account: unlinked, same currency and
 * the same IBAN last four. Anything less certain returns null (the default is a new account).
 */
export function matchExisting(
  option: LinkOption,
  accounts: LinkableAccount[],
  connectionId: string,
): LinkableAccount | null {
  if (!option.ibanLast4) return null;
  const hits = linkableAccounts(option, accounts, connectionId).filter(
    (a) => a.connectionId === null && a.ibanLast4 === option.ibanLast4,
  );
  return hits.length === 1 ? hits[0]! : null;
}

export function initialRows(
  options: LinkOption[],
  accounts: LinkableAccount[],
  connectionId: string,
  defaultType: string,
): LinkRow[] {
  const taken = new Set<string>();
  return options.map((o) => {
    const match = o.accountId === null ? matchExisting(o, accounts, connectionId) : null;
    const useMatch = match !== null && !taken.has(match.id);
    if (match && useMatch) taken.add(match.id);
    return {
      externalKey: o.externalKey,
      mode: useMatch ? 'existing' : 'create',
      name: o.name,
      type: defaultType,
      accountId: useMatch ? match.id : '',
      linkedTo: o.accountId,
      changing: false,
    };
  });
}

/** A row that will be sent: already-linked rows stay as they are unless the person changed them. */
const active = (r: LinkRow): boolean =>
  !(r.linkedTo !== null && !r.changing) && r.mode !== 'ignore';

/** A linked row the person chose to stop syncing (the account and its history stay). */
const stopping = (r: LinkRow): boolean => r.linkedTo !== null && r.changing && r.mode === 'ignore';

export type RowErrors = Record<string, { name?: 'name'; account?: 'required' | 'duplicate' }>;

export function validateRows(rows: LinkRow[]): RowErrors {
  const errors: RowErrors = {};
  const chosen = new Set(
    rows.filter((r) => r.linkedTo !== null && !r.changing).map((r) => r.linkedTo!),
  );
  for (const r of rows) {
    if (!active(r)) continue;
    if (r.mode === 'create' && (r.name.trim() === '' || r.name.trim().length > 120)) {
      errors[r.externalKey] = { name: 'name' };
    }
    if (r.mode === 'existing') {
      if (r.accountId === '') errors[r.externalKey] = { account: 'required' };
      else if (chosen.has(r.accountId)) errors[r.externalKey] = { account: 'duplicate' };
      else chosen.add(r.accountId);
    }
  }
  return errors;
}

export type LinkPayload = Array<{
  externalKey: string;
  accountId?: string;
  create?: { name: string; type: string };
  ignore?: true;
}>;

export function buildLinks(rows: LinkRow[]): LinkPayload {
  return rows
    .filter((r) => active(r) || stopping(r))
    .map((r) =>
      stopping(r)
        ? { externalKey: r.externalKey, ignore: true as const }
        : r.mode === 'create'
          ? { externalKey: r.externalKey, create: { name: r.name.trim(), type: r.type } }
          : { externalKey: r.externalKey, accountId: r.accountId },
    );
}

/** How many accounts a payload links (accounts being stopped are not counted). */
export function linkCount(links: LinkPayload): number {
  return links.filter((l) => !l.ignore).length;
}
