import { foldText } from './fold';

export type TransferCandidate = {
  id: string;
  accountId: string;
  bookingDate: string;
  amount: number;
  currency: string;
};

const MS_PER_DAY = 86_400_000;

function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pairs outflow/inflow legs of equal and opposite amount on different accounts.
 * A pair is made only when each leg is the other's single possible partner; any
 * other leg that has at least one possible partner is reported as ambiguous.
 */
export function findTransferPairs(
  cands: TransferCandidate[],
  opts: { windowDays?: number } = {},
): { pairs: Array<[string, string]>; ambiguous: string[] } {
  const windowDays = opts.windowDays ?? 3;
  const outs = cands.filter((c) => c.amount < 0);
  const outIds = new Set(outs.map((o) => o.id));
  const ins = cands.filter((c) => c.amount > 0);

  const partners = new Map<string, string[]>();
  const link = (from: string, to: string) =>
    partners.set(from, [...(partners.get(from) ?? []), to]);
  for (const o of outs) {
    for (const i of ins) {
      if (
        o.amount === -i.amount &&
        o.currency === i.currency &&
        o.accountId !== i.accountId &&
        Math.abs(dayNumber(o.bookingDate) - dayNumber(i.bookingDate)) <= windowDays
      ) {
        link(o.id, i.id);
        link(i.id, o.id);
      }
    }
  }

  const pairs: Array<[string, string]> = [];
  const ambiguous: string[] = [];
  for (const [id, list] of partners) {
    const isOut = outIds.has(id);
    const only = list.length === 1 ? list[0]! : null;
    if (only !== null && partners.get(only)?.length === 1) {
      if (isOut) pairs.push([id, only]);
    } else {
      ambiguous.push(id);
    }
  }
  pairs.sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1]));
  ambiguous.sort(byText);
  return { pairs, ambiguous };
}

/** Generic words banks put on a move between one's own accounts (folded, space-separated). */
const OWN_TRANSFER_MARKERS = [
  ' TRANSFER ',
  ' TRANSFERENCIA ',
  ' TOP UP ',
  ' TOPUP ',
  ' CARREGAMENTO ',
];

const tokens = (s: string) =>
  foldText(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
const words = (s: string) => ` ${tokens(s).join(' ')} `;

/** Legal-form suffixes dropped from an institution name ("Revolut Ltd" is "Revolut"). */
const LEGAL_SUFFIXES = new Set([
  'LTD',
  'LIMITED',
  'UAB',
  'SA',
  'SAS',
  'AG',
  'GMBH',
  'INC',
  'LLC',
  'PLC',
  'BV',
  'NV',
]);
/** Words too common to identify an institution on their own. */
const GENERIC_WORDS = new Set([
  'BANK',
  'BANCO',
  'CONTA',
  'ACCOUNT',
  'CARD',
  'CARTAO',
  'SAVINGS',
  'POUPANCA',
  'CURRENT',
  'MAIN',
  'CAIXA',
]);

/** True when consecutive tokens of the text, spaces removed, spell `compact` exactly. */
function hasTokenRun(textTokens: string[], compact: string): boolean {
  for (let i = 0; i < textTokens.length; i++) {
    let run = '';
    for (let j = i; j < textTokens.length && run.length < compact.length; j++) {
      run += textTokens[j];
      if (run === compact) return true;
    }
  }
  return false;
}

/** The spellings of an account label a text may use: the whole name, and the brand before a legal suffix. */
function labelSpellings(label: string): string[] {
  const all = tokens(label);
  const core = all.filter((t) => !LEGAL_SUFFIXES.has(t));
  const out = [core.join('')];
  const first = core[0];
  if (core.length < all.length && first && first.length >= 4 && !GENERIC_WORDS.has(first)) {
    out.push(first);
  }
  return out.filter((c) => c.length >= 3);
}

/**
 * True when a leg's text points at the account on the other side: its name or institution as
 * whole tokens, ignoring spaces ("To Trading212" for "Trading 212") and legal suffixes ("Revolut
 * Ltd"), or a generic own-transfer marker ("transfer", "top up", "carregamento"). Used to let an
 * automatic category give way to pairing: a card payment of the same amount as an unrelated
 * deposit carries none of these.
 */
export function referencesOtherAccount(
  text: string,
  other: { name: string; institutionName?: string | null },
): boolean {
  if (OWN_TRANSFER_MARKERS.some((m) => words(text).includes(m))) return true;
  const textTokens = tokens(text);
  return [other.name, other.institutionName].some(
    (label) => !!label && labelSpellings(label).some((c) => hasTokenRun(textTokens, c)),
  );
}

/**
 * An investment-platform deposit or withdrawal is by nature money moving from or to the owner's
 * bank: the provider type DEPOSIT/WITHDRAW (Trading 212 sets it), or such a description on an
 * investment account. Bank texts that merely say "deposit" do not count.
 */
export function isPlatformTransferLeg(leg: {
  rawDescription: string;
  providerType?: string | null;
  accountType: string;
}): boolean {
  const type = leg.providerType?.toUpperCase();
  if (type === 'DEPOSIT' || type === 'WITHDRAW') return true;
  return (
    leg.accountType === 'investment' &&
    /^(DEPOSIT|WITHDRAW) /.test(foldText(leg.rawDescription) + ' ')
  );
}
