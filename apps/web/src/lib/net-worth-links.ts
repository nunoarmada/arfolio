/**
 * Which accounts an asset or a liability can be linked to. A linked record is valued through its
 * account, so only an account that counts towards net worth (live, "include in net worth") on the
 * record's own side makes sense: an asset takes any account but a loan or a card; a liability
 * takes a loan, a card, or an account that is negative now. An account another record already
 * counts is left out (the services refuse a second link). The account a record is linked to now
 * always stays.
 */

export interface LinkableAccount {
  id: string;
  name: string;
  type: string;
  includeInNetWorth: boolean;
  archived: boolean;
  /** Current balance, signed minor units. */
  balance: number;
}

export type LinkSide = 'asset' | 'liability';

function fitsSide(side: LinkSide, a: LinkableAccount): boolean {
  if (side === 'asset') return a.type !== 'loan' && a.type !== 'card';
  return a.type === 'loan' || a.type === 'card' || a.balance < 0;
}

/** The choices in the account's own order, as `{ id, name }`. */
export function linkableFor(
  side: LinkSide,
  accounts: readonly LinkableAccount[],
  opts: { current: string | null; claimed?: ReadonlySet<string> },
): Array<{ id: string; name: string }> {
  return accounts
    .filter(
      (a) =>
        a.id === opts.current ||
        (!a.archived &&
          a.includeInNetWorth &&
          fitsSide(side, a) &&
          !(opts.claimed?.has(a.id) ?? false)),
    )
    .map((a) => ({ id: a.id, name: a.name }));
}
