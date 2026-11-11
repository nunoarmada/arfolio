import { and, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  mapTrading212Balances,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
  type ProviderBalance,
  type ProviderPie,
  type ProviderPieDetail,
  type ProviderPosition,
  type ProviderTx,
  type PsuHeaders,
} from '@arfolio/connectors';
import { DecryptError, decryptSecret } from '@arfolio/core/server';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import {
  manualRefreshAllowance,
  readCredentials,
  recentManualRuns,
  nowOf,
  secretAad,
  tryLock,
  type ConnectorDeps,
  type Trading212Port,
} from './connections.js';
import {
  assertCanWrite,
  assertUuid,
  NotFoundError,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { consentExpiredKey, createNotificationInTx, isoDay } from './notifications.js';
import { expireVanishedPending, ingestTransactions, type IngestResult } from './pipeline.js';

const {
  balanceSnapshot,
  connection,
  connectionAccount,
  householdSettings,
  investmentBucket,
  investmentBucketHolding,
  investmentBucketSnapshot,
  organization,
  positionSnapshot,
  syncRun,
} = schema;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const DEFAULT_SYNC_HOUR = 6;
const JITTER_MINUTES = 20;
/** Banks reject a window of exactly 90 days (the limit is exclusive), so ask for one day less. */
const INITIAL_LOOKBACK_DAYS = 89;
/** Hard cap on how far back a bank window reaches, however stale `last_success_at` is. */
const MAX_LOOKBACK_DAYS = 89;
/**
 * PSD2 lets a bank refuse more than about 4 unattended calls per account per day. A scheduled
 * run uses 2 per account, so an unattended Enable Banking run is skipped when an earlier one
 * (success or partial) started less than this long ago.
 */
const UNATTENDED_MIN_GAP_MS = 20 * 60 * MINUTE_MS;
const OVERLAP_DAYS = 7;
/** One quick retry after a transient provider failure, instead of waiting for the next day. */
const TRANSIENT_RETRY_MS = 3 * 60 * MINUTE_MS;
const FAILURES_BEFORE_NOTIFYING = 2;
const SYNC_USER = 'system:sync';

// ---------------------------------------------------------------------------------------------
// Scheduling arithmetic (Intl only: no Temporal, no date library)
// ---------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      // An unknown zone name in settings must not stop syncing: fall back to UTC.
      return formatterFor('UTC');
    }
    formatters.set(timeZone, f);
  }
  return f;
}

type Wall = { year: number; month: number; day: number };

function wallClock(ms: number, timeZone: string): Wall & { asUtc: number } {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return { year: parts.year!, month: parts.month!, day: parts.day!, asUtc };
}

/** Offset of `timeZone` from UTC at an instant, in ms (local = utc + offset). */
function offsetAt(ms: number, timeZone: string): number {
  return wallClock(ms, timeZone).asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock of `timeZone` reads the given local time. */
function wallToInstant(wall: Wall, hour: number, timeZone: string): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, hour, 0, 0);
  // The offset must be taken near the answer, not near the guess: it differs across a DST change.
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** The local calendar day (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDay(date: Date, timeZone: string): string {
  const w = wallClock(date.getTime(), timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/**
 * The next occurrence of `syncHour`:00 in `timezone` strictly after `now`, plus 0-20 minutes of
 * jitter so households do not hit providers at the same instant. Local wall time is converted
 * per day, so the result follows DST changes (06:00 is 06:00Z in winter, 05:00Z in summer in
 * Lisbon).
 */
export function computeNextSyncAt(opts: {
  now: Date;
  timezone: string;
  syncHour?: number;
  random?: () => number;
}): Date {
  const hour = opts.syncHour ?? DEFAULT_SYNC_HOUR;
  const random = opts.random ?? Math.random;
  const today = wallClock(opts.now.getTime(), opts.timezone);
  for (let ahead = 0; ahead <= 2; ahead++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
    const candidate = wallToInstant(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
      hour,
      opts.timezone,
    );
    if (candidate > opts.now.getTime()) {
      return new Date(candidate + Math.floor(random() * JITTER_MINUTES * MINUTE_MS));
    }
  }
  // Unreachable: two days ahead always lies in the future.
  return new Date(opts.now.getTime() + DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// Errors and result types
// ---------------------------------------------------------------------------------------------

/** A manual refresh was asked for too soon; `retryAt` is when the allowance frees up. */
export class ManualRefreshLimitError extends Error {
  constructor(readonly retryAt: Date) {
    super(`Manual refresh limit reached; try again after ${retryAt.toISOString()}`);
    this.name = 'ManualRefreshLimitError';
  }
}

export type SyncTriggerKind = 'scheduled' | 'manual' | 'initial';

export type SyncRunResult =
  | { status: 'skipped'; reason: 'locked' | 'not_due' | 'inactive' | 'daily_budget' }
  | {
      status: 'success' | 'partial' | 'failed';
      runId: string;
      inserted: number;
      duplicates: number;
      pendingReplaced: number;
      providerCalls: number;
      errorCode: string | null;
    };

export type SyncDeps = ConnectorDeps & {
  db: Db;
  /** Jitter source; injectable for tests. */
  random?: () => number;
  /** Where non-fatal problems are reported; defaults to the console. */
  logger?: { warn(message: string): void };
};

type Failure = { code: string; message: string; kind: 'auth' | 'rate' | 'other' };

/**
 * Maps any error to a short code and a fixed, safe message. Provider and library messages are
 * never stored: they can carry URLs, session ids or fragments of credentials.
 */
function classify(error: unknown): Failure {
  if (error instanceof ProviderAuthError) {
    return {
      code: 'auth',
      message: 'The provider rejected the credentials or consent; reconnect to resume syncing',
      kind: 'auth',
    };
  }
  if (error instanceof ProviderRateLimitError) {
    return {
      code: 'rate_limited',
      message: 'The provider rate limit was reached; the next sync will try again',
      kind: 'rate',
    };
  }
  if (error instanceof ProviderUnavailableError) {
    return {
      code: 'unavailable',
      message: 'The provider is temporarily unavailable',
      kind: 'other',
    };
  }
  if (error instanceof ProviderResponseError) {
    return {
      code: 'bad_response',
      message: 'The provider returned an unexpected response',
      kind: 'other',
    };
  }
  if (error instanceof DecryptError) {
    return {
      code: 'decrypt_failed',
      message: 'Stored credentials could not be read',
      kind: 'other',
    };
  }
  if (error instanceof ValidationError) {
    return { code: 'rejected', message: 'Some provider data was rejected', kind: 'other' };
  }
  return { code: 'internal', message: 'Unexpected error during sync', kind: 'other' };
}

// ---------------------------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The sync itself
// ---------------------------------------------------------------------------------------------

type ConnectionRow = typeof connection.$inferSelect;
type LinkRow = typeof connectionAccount.$inferSelect;

/** Throws ManualRefreshLimitError when the connection used up its manual allowance. */
async function assertManualAllowance(tx: Tx, row: ConnectionRow, now: Date): Promise<void> {
  const runs = await recentManualRuns(tx, row.householdId, now, row.id);
  const allowance = manualRefreshAllowance(row.provider, runs.get(row.id) ?? [], now);
  if (allowance.retryAt !== null) throw new ManualRefreshLimitError(new Date(allowance.retryAt));
}

/** True when an unattended run of this connection succeeded (fully or partly) recently. */
async function hadRecentUnattendedRun(tx: Tx, row: ConnectionRow, now: Date): Promise<boolean> {
  const [recent] = await tx
    .select({ id: syncRun.id })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.householdId, row.householdId),
        eq(syncRun.connectionId, row.id),
        ne(syncRun.trigger, 'manual'),
        inArray(syncRun.status, ['success', 'partial']),
        gt(syncRun.startedAt, new Date(now.getTime() - UNATTENDED_MIN_GAP_MS)),
      ),
    )
    .limit(1);
  return recent !== undefined;
}

/** First day of the first window: what a never-synced connection or account asks for. */
const initialStart = (now: Date, timeZone: string): string =>
  localDay(new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * DAY_MS), timeZone);

/** First day to ask the provider for (YYYY-MM-DD in the household timezone). */
function windowStart(row: ConnectionRow, now: Date, timeZone: string): string {
  const oldest = now.getTime() - MAX_LOOKBACK_DAYS * DAY_MS;
  if (!row.lastSuccessAt) return initialStart(now, timeZone);
  const overlap = row.lastSuccessAt.getTime() - OVERLAP_DAYS * DAY_MS;
  // The consent cannot cover anything before the connection existed, and a long-failing
  // connection must not ask for an ever larger window.
  return localDay(new Date(Math.max(overlap, row.createdAt.getTime(), oldest)), timeZone);
}

type SyncWindow = {
  from: string;
  /** Where a never-synced account starts (the first window). */
  initialFrom: string;
  to: string;
  timezone: string;
};

type Tally = IngestResult & {
  calls: number;
  ok: number;
  failures: Failure[];
  incomplete: boolean;
  /** Provider rows that could not be mapped (counted, never stored). */
  skippedRows: number;
};

function addIngest(tally: Tally, result: IngestResult): void {
  tally.inserted += result.inserted;
  tally.duplicates += result.duplicates;
  tally.pendingReplaced += result.pendingReplaced;
}

/**
 * The day a balance is stored under. An available balance (ISO kinds ending in `AV`: ITAV, CLAV,
 * ...) already includes pending debits and is "as of now": the provider's reference date can lag
 * behind, and an anchor on that day would subtract a pending item again when it books later, so
 * it takes the sync's own local day. Other balances keep the provider's day; a date-time is read
 * on the household's local calendar, not UTC. Date-only values stay as they are.
 */
function balanceDay(b: ProviderBalance, syncDay: string, timeZone: string): string {
  if (b.kind.endsWith('AV') || b.asOf.length < 10) return syncDay;
  if (b.asOf.length === 10) return b.asOf;
  // A date-time without a zone is read as UTC, never as the server's local time.
  const instant = Date.parse(/T[\d:.]+$/.test(b.asOf) ? `${b.asOf}Z` : b.asOf);
  return Number.isNaN(instant) ? b.asOf.slice(0, 10) : localDay(new Date(instant), timeZone);
}

async function saveBalances(
  deps: SyncDeps,
  householdId: string,
  accountId: string,
  provider: string,
  balances: ProviderBalance[],
  syncDay: string,
  timeZone: string,
): Promise<void> {
  if (balances.length === 0) return;
  await withHousehold(deps.db, householdId, async (tx) => {
    for (const b of balances) {
      await tx
        .insert(balanceSnapshot)
        .values({
          householdId,
          accountId,
          asOf: balanceDay(b, syncDay, timeZone),
          balance: b.amount,
          currency: b.currency,
          source: `${provider}:${b.kind}`,
        })
        .onConflictDoUpdate({
          target: [balanceSnapshot.accountId, balanceSnapshot.asOf, balanceSnapshot.source],
          set: { balance: sql`excluded.balance`, currency: sql`excluded.currency` },
        });
    }
  });
}

/** Replaces the day's snapshot, so a position sold since the last run disappears. */
async function savePositions(
  deps: SyncDeps,
  householdId: string,
  accountId: string,
  day: string,
  positions: ProviderPosition[],
): Promise<void> {
  await withHousehold(deps.db, householdId, async (tx) => {
    await tx
      .delete(positionSnapshot)
      .where(and(eq(positionSnapshot.accountId, accountId), eq(positionSnapshot.asOf, day)));
    const used = new Set<string>();
    const rows = positions.map((p) => {
      // ISIN when it is free; two tickers sharing one ISIN would break the unique key.
      const instrument = p.isin && !used.has(p.isin) ? p.isin : p.ticker;
      used.add(instrument);
      const quantity = Number(p.quantity);
      return {
        householdId,
        accountId,
        asOf: day,
        instrument,
        name: p.name,
        quantity: p.quantity,
        // Account-currency unit price derived from the account-currency value.
        priceMinor: quantity > 0 ? Math.round(p.value / quantity) : 0,
        valueMinor: p.value,
        currency: p.currency,
        costMinor: p.cost,
        unrealizedPlMinor: p.unrealizedProfitLoss,
        ticker: p.ticker,
        isin: p.isin ?? null,
      };
    });
    if (rows.length > 0) await tx.insert(positionSnapshot).values(rows);
  });
}

/**
 * Stores the account's pies (investment buckets) and replaces its snapshots for the day. A pie's
 * detail (name and instruments) is fetched only for a pie that is new or has no instruments stored
 * for the day, or for every pie when the account has no snapshot for the day yet.
 */
async function saveBuckets(
  deps: SyncDeps,
  client: Trading212Port,
  args: { householdId: string; accountId: string; day: string; currency: string; now: Date },
): Promise<void> {
  const { householdId, accountId, day, currency, now } = args;
  const pies = await client.listPies(currency);
  const [known, snapshotToday, heldToday] = await withHousehold(deps.db, householdId, async (tx) =>
    Promise.all([
      tx
        .select({ id: investmentBucket.id, externalId: investmentBucket.externalId })
        .from(investmentBucket)
        .where(eq(investmentBucket.accountId, accountId)),
      tx
        .select({ bucketId: investmentBucketSnapshot.bucketId })
        .from(investmentBucketSnapshot)
        .where(
          and(
            eq(investmentBucketSnapshot.accountId, accountId),
            eq(investmentBucketSnapshot.asOf, day),
          ),
        )
        .limit(1),
      tx
        .selectDistinct({ bucketId: investmentBucketHolding.bucketId })
        .from(investmentBucketHolding)
        .where(
          and(
            eq(investmentBucketHolding.accountId, accountId),
            eq(investmentBucketHolding.asOf, day),
          ),
        ),
    ]),
  );
  const knownIds = new Set(known.map((b) => b.externalId));
  const held = new Set(heldToday.map((r) => r.bucketId));
  // Read again later the same day: a pie that holds something but has no instruments stored for
  // the day (its detail failed). An empty pie (value 0) has nothing to read.
  const missing = new Set(known.filter((b) => !held.has(b.id)).map((b) => b.externalId));
  const refreshAll = snapshotToday.length === 0;
  const details = new Map<string, ProviderPieDetail>();
  for (const pie of pies) {
    if (!refreshAll && knownIds.has(pie.id) && !(missing.has(pie.id) && pie.value > 0)) continue;
    try {
      details.set(pie.id, await client.getPieDetail(pie.id, currency));
    } catch (error) {
      // A rate limit that outlasted the client's retries: keep what was read and ask no more
      // now; the pies left without instruments are read on the next sync of the day.
      if (error instanceof ProviderRateLimitError) break;
      // One unreadable pie detail must not drop every pie: keep the stored name (or the id for a
      // new pie) and store no instruments for it. Auth errors still propagate.
      if (!(error instanceof ProviderResponseError)) throw error;
    }
  }

  await withHousehold(deps.db, householdId, async (tx) => {
    const listed = new Set(pies.map((p) => p.id));
    const bucketIds = new Map<string, string>();
    for (const pie of pies) {
      const name = details.get(pie.id)?.name;
      const [bucket] = await tx
        .insert(investmentBucket)
        .values({
          householdId,
          accountId,
          provider: 'trading212',
          externalId: pie.id,
          // A new pie whose name could not be read is stored under its id until a later day names it.
          name: name ?? pie.id,
          removedAt: null,
        })
        .onConflictDoUpdate({
          target: [investmentBucket.accountId, investmentBucket.externalId],
          set: { removedAt: null, ...(name === undefined ? {} : { name }) },
        })
        .returning({ id: investmentBucket.id });
      bucketIds.set(pie.id, bucket!.id);
    }
    const vanished = known.filter((b) => !listed.has(b.externalId)).map((b) => b.id);
    if (vanished.length > 0) {
      await tx
        .update(investmentBucket)
        .set({ removedAt: now })
        .where(and(inArray(investmentBucket.id, vanished), isNull(investmentBucket.removedAt)));
    }
    await tx
      .delete(investmentBucketSnapshot)
      .where(
        and(
          eq(investmentBucketSnapshot.accountId, accountId),
          eq(investmentBucketSnapshot.asOf, day),
        ),
      );
    const rows = pies.map((p: ProviderPie) => ({
      bucketId: bucketIds.get(p.id)!,
      householdId,
      accountId,
      asOf: day,
      investedMinor: p.invested,
      valueMinor: p.value,
      currency,
    }));
    if (rows.length > 0) await tx.insert(investmentBucketSnapshot).values(rows);

    // Instruments are replaced only for the pies whose detail was read now; the others keep the
    // rows already stored for the day (details are read once a day).
    const read = [...details.keys()].map((id) => bucketIds.get(id)!);
    if (read.length > 0) {
      await tx
        .delete(investmentBucketHolding)
        .where(
          and(
            eq(investmentBucketHolding.accountId, accountId),
            eq(investmentBucketHolding.asOf, day),
            inArray(investmentBucketHolding.bucketId, read),
          ),
        );
    }
    const holdingRows = [...details].flatMap(([id, detail]) =>
      detail.instruments.map((i) => ({
        bucketId: bucketIds.get(id)!,
        householdId,
        accountId,
        asOf: day,
        ticker: i.ticker,
        quantity: i.quantity,
        investedMinor: i.invested,
        valueMinor: i.value,
        currency,
      })),
    );
    if (holdingRows.length > 0) await tx.insert(investmentBucketHolding).values(holdingRows);
  });
}

/** The ingest reports the linked account as missing: it was deleted while the run was in flight. */
function isDeletedAccount(error: unknown): boolean {
  return error instanceof NotFoundError && error.message === 'Account not found';
}

async function syncBank(
  deps: SyncDeps,
  ctx: ServiceCtx,
  row: ConnectionRow,
  links: LinkRow[],
  window: SyncWindow,
  tally: Tally,
  psuHeaders: PsuHeaders | undefined,
): Promise<void> {
  const eb = deps.enableBanking;
  if (!eb) {
    tally.failures.push({
      code: 'not_configured',
      message: 'Bank connections are not configured on this installation',
      kind: 'other',
    });
    return;
  }
  // Decrypting proves the stored session belongs to this row; the accounts use uids from the link.
  decryptSecret(
    row.externalSessionIdEnc ?? '',
    deps.encryptionKey,
    secretAad(row.id, 'external_session_id'),
  );
  for (const link of links) {
    try {
      let skippedHere = 0;
      // An account linked after the last success (added to a running connection) has no history
      // here yet, so it gets the first window rather than the connection's overlap.
      const isNew = row.lastSuccessAt !== null && link.createdAt > row.lastSuccessAt;
      const dateFrom = isNew ? window.initialFrom : window.from;
      const rows: ProviderTx[] = await eb.listTransactions(link.externalUid, {
        dateFrom,
        dateTo: window.to,
        accountCurrency: link.currency,
        ...(psuHeaders ? { psuHeaders } : {}),
        // Each page is one call against the bank's per-account daily budget.
        onPage: () => {
          tally.calls += 1;
        },
        onSkippedRow: () => {
          tally.skippedRows += 1;
          skippedHere += 1;
        },
      });
      if (rows.length === 0 && skippedHere > 0) {
        // Rows came back but none could be read: the data is not current, so this is a failure.
        tally.failures.push({
          code: 'bad_response',
          message: 'None of the rows the provider returned could be read',
          kind: 'other',
        });
        continue;
      }
      addIngest(
        tally,
        await ingestTransactions(ctx, link.accountId, rows, { source: 'connector' }),
      );
      tally.calls += 1;
      const balances = await eb.getBalances(
        link.externalUid,
        psuHeaders ? { psuHeaders } : undefined,
      );
      await saveBalances(
        deps,
        row.householdId,
        link.accountId,
        'enablebanking',
        balances,
        window.to,
        window.timezone,
      );
      // A clean, non-empty answer is the whole truth for the window: a pending row it dropped is
      // gone. An empty answer or unreadable rows prove nothing, and rows within two days of the
      // window start may be pending items the bank simply stopped listing there.
      if (rows.length > 0 && skippedHere === 0) {
        const from = new Date(Date.parse(`${dateFrom}T00:00:00Z`) + 2 * DAY_MS);
        await expireVanishedPending(ctx, link.accountId, rows, from.toISOString().slice(0, 10));
      }
      tally.ok += 1;
    } catch (error) {
      // The account was deleted after the run loaded its links: nothing left to sync there.
      if (isDeletedAccount(error)) continue;
      const failure = classify(error);
      tally.failures.push(failure);
      // Expired consent affects every account; a rate limit means the budget is spent.
      if (failure.kind !== 'other') return;
    }
  }
}

/**
 * Trading 212 reports instants and the mapper takes their UTC date; a row booked late in the
 * evening would land on the wrong day for the household. Rows with an exact instant are moved to
 * the household's local day (new rows only matter: stored ones are matched by external id).
 */
function onLocalDay(r: ProviderTx, timeZone: string): ProviderTx {
  if (!r.occurredAt) return r;
  const day = localDay(new Date(r.occurredAt), timeZone);
  return {
    ...r,
    bookingDate: day,
    ...(r.valueDate ? { valueDate: day } : {}),
    ...(r.transactionDate ? { transactionDate: day } : {}),
  };
}

async function syncTrading212(
  deps: SyncDeps,
  ctx: ServiceCtx,
  row: ConnectionRow,
  links: LinkRow[],
  window: { from: string; to: string; timezone: string },
  tally: Tally,
): Promise<void> {
  const link = links[0];
  if (!link) return;
  try {
    const client = deps.trading212(readCredentials(deps, row));
    tally.calls += 1;
    const summary = await client.getAccountSummary();
    tally.calls += 1;
    const positions = await client.getPositions();
    tally.calls += 1;
    const history = await client.listTransactions({ since: window.from });
    tally.calls += 1;
    const dividends = await client.listDividends({ since: window.from });
    addIngest(
      tally,
      await ingestTransactions(
        ctx,
        link.accountId,
        [...history.items, ...dividends.items].map((r) => onLocalDay(r, window.timezone)),
        { source: 'connector' },
      ),
    );
    await saveBalances(
      deps,
      row.householdId,
      link.accountId,
      'trading212',
      mapTrading212Balances(summary, window.to),
      window.to,
      window.timezone,
    );
    await savePositions(deps, row.householdId, link.accountId, window.to, positions);
    try {
      await saveBuckets(deps, client, {
        householdId: row.householdId,
        accountId: link.accountId,
        day: window.to,
        currency: summary.currency,
        now: nowOf(deps),
      });
    } catch (error) {
      // Pies are optional: a missing permission or a hiccup never fails the rest of the sync.
      // Class only: provider messages can carry URLs or fragments of credentials.
      const label = error instanceof Error ? error.name : 'unknown error';
      (deps.logger ?? console).warn(`sync ${row.id}: pies skipped (${label})`);
    }
    if (history.incomplete || dividends.incomplete) tally.incomplete = true;
    tally.ok += 1;
  } catch (error) {
    if (isDeletedAccount(error)) return;
    tally.failures.push(classify(error));
  }
}

/**
 * One sync of one connection. At most one run per connection at a time (a second caller gets
 * `skipped`). Ingest is idempotent, so a run that stopped half way is simply repeated over the
 * same window: `last_success_at` only moves on a fully successful run.
 */
export async function syncConnection(
  deps: SyncDeps,
  input: {
    householdId: string;
    connectionId: string;
    trigger: SyncTriggerKind;
    /** Only for a run a person started: the bank then treats the calls as made with them present. */
    psuHeaders?: PsuHeaders;
  },
): Promise<SyncRunResult> {
  const { householdId, connectionId, trigger, psuHeaders } = input;
  assertUuid(connectionId, 'Connection');
  const lock = await tryLock(deps.db, connectionId);
  if (!lock) return { status: 'skipped', reason: 'locked' };
  try {
    return await runLocked(deps, householdId, connectionId, trigger, psuHeaders);
  } finally {
    await lock.release();
  }
}

async function runLocked(
  deps: SyncDeps,
  householdId: string,
  connectionId: string,
  trigger: SyncTriggerKind,
  psuHeaders: PsuHeaders | undefined,
): Promise<SyncRunResult> {
  const now = nowOf(deps);
  const loaded = await withHousehold(deps.db, householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.householdId, householdId)));
    if (!row) throw new NotFoundError('Connection');
    if (row.status !== 'active') return { kind: 'skip' as const, reason: 'inactive' as const };
    if (trigger !== 'manual' && row.nextSyncAt && row.nextSyncAt > now) {
      return { kind: 'skip' as const, reason: 'not_due' as const };
    }
    if (trigger === 'manual') await assertManualAllowance(tx, row, now);
    const links = await tx
      .select()
      .from(connectionAccount)
      .where(
        and(
          eq(connectionAccount.connectionId, connectionId),
          eq(connectionAccount.householdId, householdId),
        ),
      )
      .orderBy(connectionAccount.createdAt, connectionAccount.externalKey);
    const [settings] = await tx
      .select({ timezone: householdSettings.timezone })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    const timezone = settings?.timezone ?? 'UTC';
    if (
      trigger !== 'manual' &&
      row.provider === 'enablebanking' &&
      (await hadRecentUnattendedRun(tx, row, now))
    ) {
      // Record the skip and spend the slot, so the connection is not retried every tick.
      await tx.insert(syncRun).values({
        householdId,
        connectionId,
        trigger,
        status: 'skipped',
        startedAt: now,
        finishedAt: now,
        errorCode: 'daily_budget',
        errorMessage: 'Skipped to stay within the bank daily limit for unattended requests',
      });
      await tx
        .update(connection)
        .set({ nextSyncAt: computeNextSyncAt({ now, timezone, random: deps.random }) })
        .where(eq(connection.id, connectionId));
      return { kind: 'skip' as const, reason: 'daily_budget' as const };
    }
    // We hold the lock, so an older "running" row belongs to a worker that died.
    await tx
      .update(syncRun)
      .set({
        status: 'failed',
        finishedAt: now,
        errorCode: 'abandoned',
        errorMessage: 'The run did not finish (the worker stopped)',
      })
      .where(
        and(
          eq(syncRun.connectionId, connectionId),
          eq(syncRun.householdId, householdId),
          eq(syncRun.status, 'running'),
        ),
      );
    const [run] = await tx
      .insert(syncRun)
      .values({ householdId, connectionId, trigger, status: 'running', startedAt: now })
      .returning({ id: syncRun.id });
    if (trigger !== 'manual') {
      // Claiming spends the slot: a crash before the run ends must not be retried every tick.
      await tx
        .update(connection)
        .set({ nextSyncAt: computeNextSyncAt({ now, timezone, random: deps.random }) })
        .where(eq(connection.id, connectionId));
    }
    return {
      kind: 'run' as const,
      row,
      links,
      timezone,
      runId: run!.id,
    };
  });
  if (loaded.kind === 'skip') return { status: 'skipped', reason: loaded.reason };
  const { row, links, timezone, runId } = loaded;

  const tally: Tally = {
    inserted: 0,
    duplicates: 0,
    pendingReplaced: 0,
    insertedIds: [],
    calls: 0,
    ok: 0,
    failures: [],
    incomplete: false,
    skippedRows: 0,
  };
  const ctx: ServiceCtx = { db: deps.db, householdId, userId: SYNC_USER, role: 'owner' };
  try {
    if (row.consentExpiresAt && row.consentExpiresAt <= now) {
      tally.failures.push({
        code: 'consent_expired',
        message: 'The bank consent has expired; reconnect to resume syncing',
        kind: 'auth',
      });
    } else {
      const window: SyncWindow = {
        from: windowStart(row, now, timezone),
        initialFrom: initialStart(now, timezone),
        to: localDay(now, timezone),
        timezone,
      };
      if (row.provider === 'enablebanking') {
        await syncBank(deps, ctx, row, links, window, tally, psuHeaders);
      } else await syncTrading212(deps, ctx, row, links, window, tally);
    }
  } catch (error) {
    tally.failures.push(classify(error));
  }

  return finish(deps, { row, runId, timezone, now, tally, accounts: links.length });
}

async function finish(
  deps: SyncDeps,
  args: {
    row: ConnectionRow;
    runId: string;
    timezone: string;
    now: Date;
    tally: Tally;
    /** Linked accounts the run went through. */
    accounts: number;
  },
): Promise<SyncRunResult> {
  const { row, runId, timezone, now, tally, accounts } = args;
  const failure = tally.failures[0];
  const auth = tally.failures.find((f) => f.kind === 'auth');
  const status: 'success' | 'partial' | 'failed' =
    tally.failures.length === 0
      ? tally.incomplete || tally.skippedRows > 0
        ? 'partial'
        : 'success'
      : tally.ok > 0
        ? 'partial'
        : 'failed';
  const runError =
    failure ??
    (tally.incomplete
      ? {
          code: 'history_incomplete',
          message: 'The provider history was truncated; the next sync repeats this window',
          kind: 'other' as const,
        }
      : tally.skippedRows > 0
        ? {
            code: 'skipped_rows',
            message: 'Some provider rows could not be read and were left out',
            kind: 'other' as const,
          }
        : undefined);
  const random = deps.random ?? Math.random;
  const nextSyncAt = computeNextSyncAt({ now, timezone, random });
  const day = isoDay(now);

  await withHousehold(deps.db, row.householdId, async (tx) => {
    await tx
      .update(syncRun)
      .set({
        status,
        finishedAt: nowOf(deps),
        inserted: tally.inserted,
        duplicates: tally.duplicates,
        pendingReplaced: tally.pendingReplaced,
        providerCalls: tally.calls,
        skippedRows: tally.skippedRows,
        errorCode: runError?.code ?? null,
        errorMessage: runError?.message ?? null,
      })
      .where(eq(syncRun.id, runId));

    const base = { lastSyncAt: now };
    const named = { connectionId: row.id, displayName: row.displayName, provider: row.provider };
    if (auth) {
      // Only expire the secret this run used: a renewal that landed meanwhile stays active.
      const expired = await tx
        .update(connection)
        .set({
          ...base,
          status: 'expired',
          nextSyncAt: null,
          lastErrorCode: auth.code,
          lastErrorMessage: auth.message,
        })
        .where(
          and(
            eq(connection.id, row.id),
            sql`${connection.externalSessionIdEnc} is not distinct from ${row.externalSessionIdEnc}`,
            sql`${connection.credentialsEnc} is not distinct from ${row.credentialsEnc}`,
          ),
        )
        .returning({ id: connection.id });
      if (expired.length > 0) {
        await createNotificationInTx(tx, {
          householdId: row.householdId,
          kind: 'consent_expired',
          payload: { ...named, reason: auth.code },
          dedupeKey: consentExpiredKey(row.id, row.consentExpiresAt, now),
        });
      }
    } else if (failure) {
      const failures = row.consecutiveFailures + 1;
      // A first outage in which nothing synced and at most one call per account was spent (the
      // first request of each failed) is retried in a few hours, never later than the next daily
      // slot; anything that already used more of the bank's daily budget, and a repeat, wait for
      // that slot.
      const retryAt = new Date(
        now.getTime() + TRANSIENT_RETRY_MS + Math.floor(random() * JITTER_MINUTES * MINUTE_MS),
      );
      const transient = failure.code === 'unavailable' || failure.code === 'bad_response';
      const retrySoon =
        transient &&
        status === 'failed' &&
        row.consecutiveFailures === 0 &&
        tally.calls <= accounts &&
        retryAt < nextSyncAt;
      await tx
        .update(connection)
        .set({
          ...base,
          nextSyncAt: retrySoon ? retryAt : nextSyncAt,
          consecutiveFailures: failures,
          lastErrorCode: failure.code,
          lastErrorMessage: failure.message,
        })
        .where(eq(connection.id, row.id));
      if (failures >= FAILURES_BEFORE_NOTIFYING) {
        await createNotificationInTx(tx, {
          householdId: row.householdId,
          kind: 'sync_failing',
          payload: { ...named, consecutiveFailures: failures, errorCode: failure.code },
          dedupeKey: `sync-failing:${row.id}:${day}`,
        });
      }
    } else if (tally.incomplete) {
      // Neither a failure nor a full success: the counters stay as they are, but the truncated
      // history is shown on the connection so a persistently incomplete one does not go unseen.
      await tx
        .update(connection)
        .set({
          ...base,
          nextSyncAt,
          lastErrorCode: runError?.code ?? null,
          lastErrorMessage: runError?.message ?? null,
        })
        .where(eq(connection.id, row.id));
    } else {
      // Some unreadable rows keep a warning on the connection; the data is still current.
      const warning = tally.skippedRows > 0 ? runError : undefined;
      await tx
        .update(connection)
        .set({
          ...base,
          nextSyncAt,
          lastSuccessAt: now,
          consecutiveFailures: 0,
          lastErrorCode: warning?.code ?? null,
          lastErrorMessage: warning?.message ?? null,
        })
        .where(eq(connection.id, row.id));
    }
  });

  return {
    status,
    runId,
    inserted: tally.inserted,
    duplicates: tally.duplicates,
    pendingReplaced: tally.pendingReplaced,
    providerCalls: tally.calls,
    errorCode: runError?.code ?? null,
  };
}

/**
 * "Refresh now". Viewers cannot refresh. The allowance (2 per rolling day per Enable Banking
 * connection, 1 per 5 minutes for Trading 212) is checked inside the sync lock, so concurrent
 * requests cannot both pass; exceeding it throws ManualRefreshLimitError with `retryAt`.
 */
export async function requestManualSync(
  ctx: ServiceCtx,
  deps: ConnectorDeps & { random?: () => number },
  connectionId: string,
  opts: { psuHeaders?: PsuHeaders } = {},
): Promise<SyncRunResult> {
  assertCanWrite(ctx);
  assertUuid(connectionId, 'Connection');
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ status: connection.status })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.householdId, ctx.householdId))),
  );
  if (!row) throw new NotFoundError('Connection');
  if (row.status !== 'active') {
    throw new ValidationError(
      'Connection is not active; reconnect it first',
      [],
      'connection_inactive',
    );
  }
  return syncConnection(
    { ...deps, db: ctx.db },
    {
      householdId: ctx.householdId,
      connectionId,
      trigger: 'manual',
      ...(opts.psuHeaders ? { psuHeaders: opts.psuHeaders } : {}),
    },
  );
}

export type SyncAllResult = {
  /** Active connections that were attempted. */
  total: number;
  /** Runs that finished as success or partial. */
  synced: number;
  /** New movements across all runs. */
  inserted: number;
  failed: number;
  /** Already syncing (another run holds the lock, or the daily provider budget is spent). */
  busy: number;
  /** Over the manual refresh allowance; not attempted. */
  limited: number;
  /** Earliest moment a limited connection can be refreshed again (ISO), or null. */
  retryAt: string | null;
};

/** How many connections "Sync all" would refresh; the shell hides the button when none. */
export async function countActiveConnections(ctx: ServiceCtx): Promise<number> {
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(connection)
      .where(and(eq(connection.householdId, ctx.householdId), eq(connection.status, 'active'))),
  );
  return row?.n ?? 0;
}

/**
 * "Sync all": a manual refresh of every active connection of the household, one at a time.
 * Each one goes through `requestManualSync`, so the per-connection allowance still applies; a
 * connection over it is counted as `limited` instead of failing the whole request. Connections
 * that are not active (expired, revoked, pending) need renewing first and are left alone.
 */
export async function requestManualSyncAll(
  ctx: ServiceCtx,
  deps: ConnectorDeps & { random?: () => number },
  opts: { psuHeaders?: PsuHeaders } = {},
): Promise<SyncAllResult> {
  assertCanWrite(ctx);
  const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ id: connection.id })
      .from(connection)
      .where(and(eq(connection.householdId, ctx.householdId), eq(connection.status, 'active')))
      .orderBy(connection.createdAt, connection.id),
  );
  const result: SyncAllResult = {
    total: rows.length,
    synced: 0,
    inserted: 0,
    failed: 0,
    busy: 0,
    limited: 0,
    retryAt: null,
  };
  for (const { id } of rows) {
    try {
      const run = await requestManualSync(ctx, deps, id, opts);
      if (run.status === 'skipped') result.busy += 1;
      else if (run.status === 'failed') result.failed += 1;
      else {
        result.synced += 1;
        result.inserted += run.inserted;
      }
    } catch (error) {
      if (error instanceof ManualRefreshLimitError) {
        result.limited += 1;
        const at = error.retryAt.toISOString();
        if (result.retryAt === null || at < result.retryAt) result.retryAt = at;
        continue;
      }
      // Removed or deactivated between the listing and its turn: nothing to refresh.
      if (
        error instanceof NotFoundError ||
        (error instanceof ValidationError && error.code === 'connection_inactive')
      ) {
        result.total -= 1;
        continue;
      }
      throw error;
    }
  }
  return result;
}

export type DueConnection = {
  householdId: string;
  connectionId: string;
  trigger: 'initial' | 'scheduled';
};

/**
 * Active connections whose `next_sync_at` has passed, across all households (RLS needs one
 * household at a time). A connection that never synced is an `initial` run.
 */
export async function findDueConnections(db: Db, now: Date = new Date()): Promise<DueConnection[]> {
  const households = await db.select({ id: organization.id }).from(organization);
  const due: DueConnection[] = [];
  for (const { id: householdId } of households) {
    const rows = await withHousehold(db, householdId, (tx) =>
      tx
        .select({
          id: connection.id,
          lastSuccessAt: connection.lastSuccessAt,
          lastSyncAt: connection.lastSyncAt,
        })
        .from(connection)
        .where(
          and(
            eq(connection.householdId, householdId),
            eq(connection.status, 'active'),
            lte(connection.nextSyncAt, now),
          ),
        )
        .orderBy(connection.nextSyncAt),
    );
    for (const r of rows) {
      due.push({
        householdId,
        connectionId: r.id,
        trigger: r.lastSuccessAt === null && r.lastSyncAt === null ? 'initial' : 'scheduled',
      });
    }
  }
  return due;
}
