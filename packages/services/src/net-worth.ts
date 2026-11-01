import { and, asc, eq, gt, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  composeNetWorth,
  depreciatedValue,
  scheduledBalanceAt,
  type NetWorthItem,
} from '@arfolio/core';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import { scheduleParamsOf } from './liabilities.js';
import {
  assertCanWrite,
  calendarDate,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { localDay } from './sync.js';

const { asset, liability, netWorthSnapshot, householdSettings, organization } = schema;

/** What `net_worth_snapshot.breakdown` holds. */
export type NetWorthBreakdown = schema.NetWorthBreakdown;
export type NetWorthSnapshot = typeof netWorthSnapshot.$inferSelect;

export type AccountBalanceSource = 'ledger' | 'snapshot' | 'positions';
export type AccountBalanceAt = {
  accountId: string;
  name: string;
  type: schema.AccountType;
  currency: string;
  /** Signed minor units. */
  balance: number;
  /**
   * The part of `balance` that is money, not invested (`cash + invested === balance`). An
   * investment account anchored on its Trading 212 total splits it by that day's `investments`
   * figure; any other investment account is all invested; every other account is all cash.
   */
  cash: number;
  invested: number;
  source: AccountBalanceSource;
  /** Date of the snapshot, positions or last booking that supplied the balance; null if none. */
  asOf: string | null;
  /** Credit limit of a card, minor units; null when unset or not a card. */
  creditLimit: number | null;
};

/**
 * What a card owes, minor units. A bank-reported balance on a card with a credit limit is the
 * available credit (some banks), so it owes limit − balance; otherwise the balance is
 * signed and only a negative one is owed. Negative when over-paid past the limit.
 */
export function cardOwed(a: {
  balance: number;
  source: AccountBalanceSource;
  creditLimit: number | null;
}): number {
  if (a.source === 'snapshot' && a.creditLimit !== null) return a.creditLimit - a.balance;
  return Math.max(0, -a.balance);
}

export type NetWorthLineItem = NetWorthItem & {
  source: 'account' | 'asset' | 'liability';
  /** Id of the account, asset or liability. */
  refId: string;
  name: string;
  /** Linked to an account: valued through it, so this entry itself adds nothing (amount 0). */
  linked: boolean;
  viaAccountId: string | null;
  foreignCurrency: boolean;
  /** Date of the valuation, balance, snapshot or booking that supplied the amount, if any. */
  asOf: string | null;
  /** False for an asset or liability with no value on or before the date: amount 0, not summed. */
  hasValue: boolean;
};

export type LatestValue = {
  refId: string;
  side: 'asset' | 'liability';
  asOf: string | null;
  value: number | null;
  /** The valuation method or balance source of the value. */
  source: string | null;
};

export type NetWorthAt = {
  date: string;
  currency: string;
  assets: number;
  liabilities: number;
  net: number;
  /** Household-currency totals keyed `${side}:${kind}`. */
  byKind: Record<string, number>;
  items: NetWorthLineItem[];
  /** The items in another currency: listed, never summed (no FX). */
  foreign: NetWorthLineItem[];
};

export type NetWorthHistoryRow = {
  month: string;
  assets: number;
  liabilities: number;
  net: number;
  /** Difference from the previous returned month's net; null for the first. */
  change: number | null;
};

export type NetWorthDeps = { db: Db; now?: Date };

const rangeSchema = z.strictObject({ from: calendarDate, to: calendarDate });

type AccountRow = {
  id: string;
  name: string;
  type: string;
  currency: string;
  credit_limit: string | null;
  ledger: string;
  last_booking: string | null;
  anchor_as_of: string | null;
  anchored: string | null;
  anchored_last_booking: string | null;
  anchored_invested: string | null;
  positions_value: string | null;
  positions_as_of: string | null;
};
type ValuationRow = { asset_id: string; as_of: string; value: string };
type BalanceRow = { liability_id: string; as_of: string; balance: string };
type LatestRow = {
  ref_id: string;
  side: 'asset' | 'liability';
  as_of: string | null;
  value: string | null;
  source: string | null;
};
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? res) as T[];

function toNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Amount out of range: ${value}`);
  return n;
}

/** First day (YYYY-MM-01) of the month containing `date`. */
export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;

function addMonths(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

function lastDayOf(month: string): string {
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return `${month.slice(0, 8)}${String(last.getUTCDate()).padStart(2, '0')}`;
}

export async function householdClock(
  tx: Tx,
  householdId: string,
  now: Date,
): Promise<{ currency: string; timeZone: string; today: string }> {
  const [settings] = await tx
    .select({ currency: householdSettings.currency, timezone: householdSettings.timezone })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  if (!settings) throw new NotFoundError('Household settings');
  return {
    currency: settings.currency,
    timeZone: settings.timezone,
    today: localDay(now, settings.timezone),
  };
}

/** The household's currency and time zone, and today's date there (read: any role). */
export async function householdToday(
  ctx: ServiceCtx,
  now: Date = new Date(),
): Promise<{ currency: string; timeZone: string; today: string }> {
  return withHousehold(ctx.db, ctx.householdId, (tx) => householdClock(tx, ctx.householdId, now));
}

// ---------------------------------------------------------------------------------------------
// Account balances

/**
 * The connector balance an account's balance is anchored on, on or before `date`, for a lateral
 * join over `financial_account a`: the latest dated `balance_snapshot` in the account's currency
 * that is a booked balance. `INFO`, Trading 212's partial `cash` / `investments` figures and the
 * other available kinds (ISO 20022 `*AV`) are never an anchor. On a tie the kinds rank
 * CLBD > ITBD > OPBD/PRCD > XPCD > trading212:total > anything else.
 * Some banks report only an available balance: CLAV, then ITAV, is the anchor of an
 * account with no booked balance at all, except a card or loan, whose available balance is the
 * unused credit line rather than what is owed.
 */
const anchorSnapshot = (date: string) => sql`
  select b.as_of, b.balance, b.source
  from balance_snapshot b
  where b.household_id = a.household_id and b.account_id = a.id and b.as_of <= ${date}::date
    and b.currency = a.currency
    and (
      (b.source not like '%AV' and b.source not like '%:INFO'
        and b.source not in ('trading212:cash', 'trading212:investments'))
      or (a.type not in ('card', 'loan')
        and (b.source like '%:CLAV' or b.source like '%:ITAV'))
    )
  order by
    case when b.source like '%:CLAV' or b.source like '%:ITAV' then 1 else 0 end,
    b.as_of desc,
    case
      when b.source like '%:CLBD' then 0
      when b.source like '%:ITBD' then 1
      when b.source like '%:OPBD' or b.source like '%:PRCD' then 2
      when b.source like '%:XPCD' then 3
      when b.source = 'trading212:total' then 4
      when b.source like '%:CLAV' then 6
      when b.source like '%:ITAV' then 7
      else 5
    end,
    b.created_at desc
  limit 1`;

/**
 * The day of the position snapshots that value investment account `a` on `date` (a scalar
 * subquery; null when positions do not value it). Positions value an account only when it has no
 * Trading 212 `total` on or before the date (the total includes cash) and when they are not older
 * than its latest balance snapshot: a portfolio sold out since leaves no rows on the newer day, so
 * older positions would otherwise count forever.
 */
const positionsDay = (date: string) => sql`(
  select max(p2.as_of) from position_snapshot p2
  where p2.household_id = a.household_id and p2.account_id = a.id and p2.as_of <= ${date}::date
  having a.type = 'investment'
    and not exists (
      select 1 from balance_snapshot t
      where t.household_id = a.household_id and t.account_id = a.id
        and t.as_of <= ${date}::date and t.source = 'trading212:total' and t.currency = a.currency
    )
    and max(p2.as_of) >= coalesce(
      (
        select max(b2.as_of) from balance_snapshot b2
        where b2.household_id = a.household_id and b2.account_id = a.id
          and b2.as_of <= ${date}::date
      ),
      max(p2.as_of)
    )
)`;

/**
 * Balance of every account that counts towards net worth (not archived, include_in_net_worth) on
 * `date`, in one query. This is the one balance rule (net worth, goals and `listAccounts`). Per
 * account:
 * 1. an investment account valued by positions (see `positionsDay`) is worth those positions in
 *    its own currency;
 * 2. else, with a connector anchor (see `anchorSnapshot`), the anchor plus the booked transactions
 *    dated strictly after the anchor date up to `date` (a bank balance is taken to include its own
 *    day's bookings);
 * 3. else the ledger: opening balance plus booked transactions after the opening date.
 * An account whose opening balance date is after `date` did not exist yet and is left out.
 * `opts.all` also returns archived accounts and those excluded from net worth.
 */
export async function accountBalancesInTx(
  tx: Tx,
  householdId: string,
  date: string,
  opts: { all?: boolean } = {},
): Promise<AccountBalanceAt[]> {
  const res = await tx.execute(sql`
    select a.id, a.name, a.type, a.currency, a.credit_limit::text as credit_limit,
      (a.opening_balance + coalesce(l.delta, 0))::text as ledger,
      l.last_booking::text as last_booking,
      an.as_of::text as anchor_as_of,
      (an.balance + coalesce(af.delta, 0))::text as anchored,
      af.last_booking::text as anchored_last_booking,
      inv.balance::text as anchored_invested,
      ps.value::text as positions_value,
      ps.as_of::text as positions_as_of
    from financial_account a
    left join lateral (
      select sum(t.amount) as delta, max(t.booking_date) as last_booking
      from "transaction" t
      where t.household_id = a.household_id and t.account_id = a.id and t.status = 'booked'
        and t.booking_date <= ${date}::date
        and (a.opening_balance_date is null or t.booking_date > a.opening_balance_date)
    ) l on true
    left join lateral (${anchorSnapshot(date)}) an on true
    left join lateral (
      select sum(t.amount) as delta, max(t.booking_date) as last_booking
      from "transaction" t
      where t.household_id = a.household_id and t.account_id = a.id and t.status = 'booked'
        and t.booking_date > an.as_of and t.booking_date <= ${date}::date
    ) af on true
    left join lateral (
      select b.balance
      from balance_snapshot b
      where a.type = 'investment' and an.source = 'trading212:total'
        and b.household_id = a.household_id and b.account_id = a.id and b.as_of = an.as_of
        and b.currency = a.currency and b.source = 'trading212:investments'
      order by b.created_at desc
      limit 1
    ) inv on true
    left join lateral (
      select sum(p.value_minor) as value, max(p.as_of) as as_of
      from position_snapshot p
      where p.household_id = a.household_id and p.account_id = a.id
        and p.currency = a.currency and p.as_of = ${positionsDay(date)}
    ) ps on true
    where a.household_id = ${householdId}
      and (${opts.all === true} or (a.archived_at is null and a.include_in_net_worth))
      and (a.opening_balance_date is null or a.opening_balance_date <= ${date}::date)
    order by a.sort, a.name, a.id`);
  return rowsOf<AccountRow>(res).map((r): AccountBalanceAt => {
    const base = {
      accountId: r.id,
      name: r.name,
      type: r.type as schema.AccountType,
      currency: r.currency,
      creditLimit: r.credit_limit === null ? null : toNumber(r.credit_limit),
    };
    const split = (balance: number, invested: number | null) => {
      const part = invested ?? (r.type === 'investment' ? balance : 0);
      return { balance, cash: balance - part, invested: part };
    };
    if (r.positions_value !== null) {
      return {
        ...base,
        ...split(toNumber(r.positions_value), null),
        source: 'positions',
        asOf: r.positions_as_of,
      };
    }
    if (r.anchored !== null) {
      return {
        ...base,
        ...split(
          toNumber(r.anchored),
          r.anchored_invested === null ? null : toNumber(r.anchored_invested),
        ),
        source: 'snapshot',
        asOf: r.anchored_last_booking ?? r.anchor_as_of,
      };
    }
    return { ...base, ...split(toNumber(r.ledger), null), source: 'ledger', asOf: r.last_booking };
  });
}

/**
 * Positions held in a currency other than their account's, for the accounts valued by positions
 * on `date` (see `positionsDay`). They are not part of the account's balance, so they are returned
 * as foreign items instead of being dropped. An account valued by its Trading 212 total already
 * includes them in that total, so it lists none.
 */
async function foreignPositionsInTx(
  tx: Tx,
  householdId: string,
  date: string,
): Promise<NetWorthLineItem[]> {
  const res = await tx.execute(sql`
    select a.id, a.name, p.currency, sum(p.value_minor)::text as value, p.as_of::text as as_of
    from financial_account a
    join position_snapshot p
      on p.household_id = a.household_id and p.account_id = a.id and p.currency <> a.currency
    where a.household_id = ${householdId} and a.type = 'investment'
      and a.archived_at is null and a.include_in_net_worth
      and (a.opening_balance_date is null or a.opening_balance_date <= ${date}::date)
      and p.as_of = ${positionsDay(date)}
    group by a.id, a.name, p.currency, p.as_of
    order by a.name, a.id, p.currency`);
  return rowsOf<{ id: string; name: string; currency: string; value: string; as_of: string }>(
    res,
  ).map((r) => ({
    side: 'asset',
    kind: 'investment',
    source: 'account',
    refId: r.id,
    name: r.name,
    currency: r.currency,
    amount: toNumber(r.value),
    linked: false,
    viaAccountId: null,
    foreignCurrency: true,
    asOf: r.as_of,
    hasValue: true,
  }));
}

export async function accountBalancesAt(
  ctx: ServiceCtx,
  rawDate: string,
): Promise<AccountBalanceAt[]> {
  const date = parseInput(calendarDate, rawDate);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    accountBalancesInTx(tx, ctx.householdId, date),
  );
}

// ---------------------------------------------------------------------------------------------
// Net worth at a date

const CASH_LIKE: ReadonlySet<schema.AccountType> = new Set([
  'checking',
  'savings',
  'cash',
  'meal_benefit',
]);

/**
 * A loan is always owed and a card is always a liability (see `cardOwed`); any other account is
 * owed only while its balance is negative. An account holding both money and investments (both
 * parts positive) is two asset items: its invested part (kind `investment`) and its cash (kind
 * `cash`), same `refId`.
 */
function accountItems(a: AccountBalanceAt, householdCurrency: string): NetWorthLineItem[] {
  if (a.cash > 0 && a.invested > 0) {
    return [
      accountItem({ ...a, balance: a.invested }, householdCurrency),
      { ...accountItem({ ...a, balance: a.cash }, householdCurrency), kind: 'cash' },
    ];
  }
  const item = accountItem(a, householdCurrency);
  // an investment account holding only money (everything sold) is cash
  return [
    a.type === 'investment' && a.invested === 0 && a.cash > 0 ? { ...item, kind: 'cash' } : item,
  ];
}

/** One account as one item (see `accountItems`). */
function accountItem(a: AccountBalanceAt, householdCurrency: string): NetWorthLineItem {
  const common = {
    source: 'account' as const,
    refId: a.accountId,
    name: a.name,
    currency: a.currency,
    amount: Math.abs(a.balance),
    linked: false,
    viaAccountId: null,
    foreignCurrency: a.currency !== householdCurrency,
    asOf: a.asOf,
    hasValue: true,
  };
  if (a.type === 'loan') return { ...common, side: 'liability', kind: 'loan' };
  if (a.type === 'card') return { ...common, side: 'liability', kind: 'card', amount: cardOwed(a) };
  if (a.balance < 0) return { ...common, side: 'liability', kind: 'debt' };
  const kind = CASH_LIKE.has(a.type) ? 'cash' : a.type === 'investment' ? 'investment' : 'other';
  return { ...common, side: 'asset', kind };
}

export async function netWorthInTx(tx: Tx, householdId: string, date: string): Promise<NetWorthAt> {
  const [settings] = await tx
    .select({ currency: householdSettings.currency })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  if (!settings) throw new NotFoundError('Household settings');
  const currency = settings.currency;

  const counted: NetWorthLineItem[] = [];
  const linked: NetWorthLineItem[] = [];
  const valueless: NetWorthLineItem[] = [];
  const accountRows = (await accountBalancesInTx(tx, householdId, date)).flatMap((a) =>
    accountItems(a, currency),
  );
  const foreignPositions = (await foreignPositionsInTx(tx, householdId, date)).map((i) => ({
    ...i,
    foreignCurrency: i.currency !== currency,
  }));

  const assets = await tx
    .select()
    .from(asset)
    .where(
      and(
        eq(asset.householdId, householdId),
        eq(asset.archived, false),
        or(isNull(asset.disposedOn), gt(asset.disposedOn, date)),
      ),
    )
    .orderBy(asc(asset.position), asc(asset.name), asc(asset.id));
  // Latest valuation per asset on or before the date; a depreciating asset starts from its latest
  // non-'depreciation' valuation.
  const valuations = new Map(
    rowsOf<ValuationRow>(
      await tx.execute(sql`
        select distinct on (v.asset_id) v.asset_id, v.as_of::text as as_of, v.value::text as value
        from asset_valuation v
        join asset a on a.id = v.asset_id and a.household_id = v.household_id
        where v.household_id = ${householdId} and v.as_of <= ${date}::date
          and (a.depreciation_bps_per_year is null or v.method <> 'depreciation')
        order by v.asset_id, v.as_of desc`),
    ).map((r) => [r.asset_id, { asOf: r.as_of, value: toNumber(r.value) }] as const),
  );
  for (const a of assets) {
    const item = {
      side: 'asset' as const,
      kind: a.kind,
      source: 'asset' as const,
      refId: a.id,
      name: a.name,
      currency: a.currency,
      foreignCurrency: a.currency !== currency,
    };
    if (a.accountId) {
      linked.push({
        ...item,
        amount: 0,
        linked: true,
        viaAccountId: a.accountId,
        asOf: null,
        hasValue: true,
      });
      continue;
    }
    const v = valuations.get(a.id);
    if (!v) {
      // not valued yet on that date: listed, never summed
      valueless.push({
        ...item,
        amount: 0,
        linked: false,
        viaAccountId: null,
        asOf: null,
        hasValue: false,
      });
      continue;
    }
    const amount =
      a.depreciationBpsPerYear === null
        ? v.value
        : depreciatedValue(v.value, v.asOf, date, a.depreciationBpsPerYear);
    counted.push({
      ...item,
      amount,
      linked: false,
      viaAccountId: null,
      asOf: v.asOf,
      hasValue: true,
    });
  }

  const liabilities = await tx
    .select()
    .from(liability)
    .where(
      and(
        eq(liability.householdId, householdId),
        eq(liability.archived, false),
        or(isNull(liability.settledOn), gt(liability.settledOn, date)),
      ),
    )
    .orderBy(asc(liability.position), asc(liability.name), asc(liability.id));
  const balances = new Map(
    rowsOf<BalanceRow>(
      await tx.execute(sql`
        select distinct on (b.liability_id) b.liability_id, b.as_of::text as as_of, b.balance::text as balance
        from liability_balance b
        where b.household_id = ${householdId} and b.as_of <= ${date}::date
        order by b.liability_id, b.as_of desc`),
    ).map((r) => [r.liability_id, { asOf: r.as_of, balance: toNumber(r.balance) }] as const),
  );
  for (const l of liabilities) {
    const item = {
      side: 'liability' as const,
      kind: l.kind,
      source: 'liability' as const,
      refId: l.id,
      name: l.name,
      currency: l.currency,
      foreignCurrency: l.currency !== currency,
    };
    if (l.accountId) {
      linked.push({
        ...item,
        amount: 0,
        linked: true,
        viaAccountId: l.accountId,
        asOf: null,
        hasValue: true,
      });
      continue;
    }
    const recorded = balances.get(l.id);
    let amount = recorded?.balance;
    if (amount === undefined) {
      const notBorrowedYet = l.startDate !== null && l.startDate > date;
      const params = scheduleParamsOf(l);
      if (!notBorrowedYet) {
        amount = params ? scheduledBalanceAt(params, date) : (l.principal ?? undefined);
      }
    }
    if (amount === undefined) {
      // not borrowed yet, or nothing known about what is owed: listed, never summed
      valueless.push({
        ...item,
        amount: 0,
        linked: false,
        viaAccountId: null,
        asOf: null,
        hasValue: false,
      });
      continue;
    }
    counted.push({
      ...item,
      amount,
      linked: false,
      viaAccountId: null,
      asOf: recorded?.asOf ?? null,
      hasValue: true,
    });
  }

  // A linked record gives its account's amount its own kind (a mortgage, not just a loan).
  const kindVia = new Map<string, string>();
  for (const l of linked) {
    const key = `${l.viaAccountId}:${l.side}`;
    if (!kindVia.has(key)) kindVia.set(key, l.kind);
  }
  // A split account's cash keeps kind `cash`: the linked record names its invested part.
  const fromAccounts = accountRows.map((i, n) => {
    const splitCash =
      i.kind === 'cash' && accountRows.some((o, m) => m !== n && o.refId === i.refId);
    return splitCash ? i : { ...i, kind: kindVia.get(`${i.refId}:${i.side}`) ?? i.kind };
  });
  const all = [...fromAccounts, ...foreignPositions, ...counted];
  const composed = composeNetWorth(all, currency);
  return {
    date,
    currency,
    assets: composed.assets,
    liabilities: composed.liabilities,
    net: composed.net,
    byKind: composed.byKind,
    items: [...all, ...linked, ...valueless],
    foreign: composed.foreign,
  };
}

/**
 * Net worth on `date` (read: any role): accounts at their balance that day, assets at their latest
 * valuation, liabilities at their latest balance or repayment schedule. An asset or liability
 * linked to an account is valued through that account and appears as `linked` with amount 0.
 */
export async function netWorthAt(ctx: ServiceCtx, rawDate: string): Promise<NetWorthAt> {
  const date = parseInput(calendarDate, rawDate);
  return withHousehold(ctx.db, ctx.householdId, (tx) => netWorthInTx(tx, ctx.householdId, date));
}

/**
 * The latest valuation of every non-archived asset and the latest balance of every non-archived
 * liability on or before `date` (default: today in the household time zone), in one statement
 * (read: any role). A record with no value yet is returned with nulls. `source` is the valuation
 * method or balance source; the newest date wins whatever its source. Assets come first, then
 * liabilities, each in the user's order.
 */
export async function latestValues(ctx: ServiceCtx, rawDate?: string): Promise<LatestValue[]> {
  const given = rawDate === undefined ? undefined : parseInput(calendarDate, rawDate);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const date = given ?? (await householdClock(tx, ctx.householdId, new Date())).today;
    const res = await tx.execute(sql`
      select ref_id, side, as_of, value, source from (
        select a.id as ref_id, 'asset' as side, a.position, a.name,
          v.as_of::text as as_of, v.value::text as value, v.method as source
        from asset a
        left join lateral (
          select x.as_of, x.value, x.method
          from asset_valuation x
          where x.household_id = a.household_id and x.asset_id = a.id and x.as_of <= ${date}::date
          order by x.as_of desc
          limit 1
        ) v on true
        where a.household_id = ${ctx.householdId} and not a.archived
          and (a.disposed_on is null or a.disposed_on > ${date}::date)
        union all
        select l.id, 'liability', l.position, l.name,
          b.as_of::text, b.balance::text, b.source
        from liability l
        left join lateral (
          select x.as_of, x.balance, x.source
          from liability_balance x
          where x.household_id = l.household_id and x.liability_id = l.id
            and x.as_of <= ${date}::date
          order by x.as_of desc
          limit 1
        ) b on true
        where l.household_id = ${ctx.householdId} and not l.archived
          and (l.settled_on is null or l.settled_on > ${date}::date)
      ) latest
      order by side, position, name, ref_id`);
    return rowsOf<LatestRow>(res).map((r) => ({
      refId: r.ref_id,
      side: r.side,
      asOf: r.as_of,
      value: r.value === null ? null : toNumber(r.value),
      source: r.source,
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// Snapshots and history

/** Every household, for the monthly job to queue one snapshot per household. */
export async function findNetWorthHouseholds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: organization.id }).from(organization);
  return rows.map((r) => r.id);
}

/**
 * Stores the net worth of `month` (the first day of a past month) as of its last day. Recomputing
 * replaces the stored row, so a rerun after late bank data is safe. The current and future months
 * are never frozen.
 */
export async function snapshotNetWorth(
  deps: NetWorthDeps,
  householdId: string,
  rawMonth: string,
): Promise<NetWorthSnapshot> {
  const month = parseInput(calendarDate, rawMonth);
  if (month !== monthStart(month)) {
    throw new ValidationError('A snapshot month must be the first day of a month');
  }
  const now = deps.now ?? new Date();
  return withHousehold(deps.db, householdId, async (tx) => {
    const { today } = await householdClock(tx, householdId, now);
    if (month >= monthStart(today)) {
      throw new ValidationError('Only a month that has ended can be stored');
    }
    return storeSnapshotInTx(tx, householdId, month, now);
  });
}

/** Computes `month` as of its last day and stores it, replacing a stored row. No checks. */
async function storeSnapshotInTx(
  tx: Tx,
  householdId: string,
  month: string,
  now: Date,
): Promise<NetWorthSnapshot> {
  const nw = await netWorthInTx(tx, householdId, lastDayOf(month));
  const values = {
    assets: nw.assets,
    liabilities: nw.liabilities,
    net: nw.net,
    breakdown: { byKind: nw.byKind, foreignCount: nw.foreign.length } satisfies NetWorthBreakdown,
    computedAt: now,
  };
  const [row] = await tx
    .insert(netWorthSnapshot)
    .values({ householdId, month, ...values })
    .onConflictDoUpdate({
      target: [netWorthSnapshot.householdId, netWorthSnapshot.month],
      set: values,
    })
    .returning();
  return row!;
}

/**
 * After a back-dated change (a valuation, a balance, an import), recomputes in the caller's
 * transaction the stored snapshots of the months from the one containing `fromDate` up to the last
 * month that has ended. A month with no stored snapshot stays a gap: nothing is created. Returns
 * how many months were recomputed. No role check.
 */
export async function refreshStoredSnapshotsInTx(
  tx: Tx,
  householdId: string,
  fromDate: string,
  now: Date = new Date(),
): Promise<number> {
  const { today } = await householdClock(tx, householdId, now);
  const stored = await tx
    .select({ month: netWorthSnapshot.month })
    .from(netWorthSnapshot)
    .where(
      and(
        eq(netWorthSnapshot.householdId, householdId),
        gte(netWorthSnapshot.month, monthStart(fromDate)),
        lt(netWorthSnapshot.month, monthStart(today)),
      ),
    )
    .orderBy(asc(netWorthSnapshot.month));
  for (const { month } of stored) await storeSnapshotInTx(tx, householdId, month, now);
  return stored.length;
}

/**
 * Recomputes every stored snapshot that has ended, for a change whose first affected month is
 * unknown or reaches back to the start (a link, a rate, a schedule, an archive). Same
 * transaction, same gap rule as `refreshStoredSnapshotsInTx`. No role check.
 */
export function refreshAllStoredSnapshotsInTx(tx: Tx, householdId: string): Promise<number> {
  return refreshStoredSnapshotsInTx(tx, householdId, '0001-01-01');
}

/** Stores the month before the household's current one (what the monthly job runs). */
export async function snapshotPreviousMonth(
  deps: NetWorthDeps,
  householdId: string,
): Promise<NetWorthSnapshot> {
  const now = deps.now ?? new Date();
  const today = await withHousehold(deps.db, householdId, async (tx) => {
    return (await householdClock(tx, householdId, now)).today;
  });
  return snapshotNetWorth(deps, householdId, addMonths(monthStart(today), -1));
}

/** "Recalcular": a member or owner recomputes the stored net worth of a past month. */
export async function recalculateNetWorthSnapshot(
  ctx: ServiceCtx,
  month: string,
  opts: { now?: Date } = {},
): Promise<NetWorthSnapshot> {
  assertCanWrite(ctx);
  return snapshotNetWorth(
    { db: ctx.db, ...(opts.now ? { now: opts.now } : {}) },
    ctx.householdId,
    month,
  );
}

/**
 * Month-by-month net worth for the months touched by [from, to] (read: any role): stored snapshots
 * for past months plus the current month computed live as of today. A past month without a stored
 * snapshot is left out (a gap, not a zero); months after the current one do not exist yet.
 */
export async function netWorthHistory(
  ctx: ServiceCtx,
  rawRange: { from: string; to: string },
  opts: { now?: Date } = {},
): Promise<NetWorthHistoryRow[]> {
  const { from, to } = parseInput(rangeSchema, rawRange);
  if (from > to) throw new ValidationError('The range starts after it ends');
  const now = opts.now ?? new Date();
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const { today } = await householdClock(tx, ctx.householdId, now);
    const current = monthStart(today);
    const stored = await tx
      .select()
      .from(netWorthSnapshot)
      .where(
        and(
          eq(netWorthSnapshot.householdId, ctx.householdId),
          gte(netWorthSnapshot.month, monthStart(from)),
          lte(netWorthSnapshot.month, monthStart(to)),
        ),
      )
      .orderBy(asc(netWorthSnapshot.month));
    const points = stored
      .filter((s) => s.month < current)
      .map((s) => ({ month: s.month, assets: s.assets, liabilities: s.liabilities, net: s.net }));
    if (monthStart(from) <= current && current <= monthStart(to)) {
      const live = await netWorthInTx(tx, ctx.householdId, today);
      points.push({
        month: current,
        assets: live.assets,
        liabilities: live.liabilities,
        net: live.net,
      });
    }
    return points.map((p, i) => ({ ...p, change: i === 0 ? null : p.net - points[i - 1]!.net }));
  });
}
