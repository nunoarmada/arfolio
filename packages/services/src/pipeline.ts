import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  findTransferPairs,
  isPlatformTransferLeg,
  namesAccount,
  parseTransactionDetails,
  referencesOtherAccount,
  type TransactionDetails,
} from '@arfolio/core';
import { assignOccurrences, dedupeHash, dedupeKey } from '@arfolio/core/server';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertUuid,
  currencyCode,
  isoDate,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { mergeDetailsSql } from './details-sql.js';
import { categorizeInTx, type CategorisationResult } from './rules.js';
import {
  ensureTransferCategory,
  linkTransferLegs,
  lockTransfers,
  TransferLinkConflictError,
  transferCandidateFilter,
} from './transactions.js';

const { financialAccount, importBatch, transaction } = schema;

/** One insert statement carries at most this many rows. */
export const INSERT_CHUNK = 500;
export const ID_CHUNK = 1_000;
/** Transfer legs are paired when booked within this many days of each other. */
const TRANSFER_WINDOW_DAYS = 5;
const DEFAULT_TRANSFER_LOOKBACK_DAYS = 60;
const MAX_ROWS_PER_CALL = 50_000;
const DAY_MS = 86_400_000;

const ingestRowSchema = z.strictObject({
  externalId: z.string().min(1).max(200).optional(),
  bookingDate: isoDate,
  valueDate: isoDate.optional(),
  amount: z.number().int().safe(),
  currency: currencyCode,
  description: z.string().trim().min(1).max(1_000),
  counterparty: z.string().trim().min(1).max(300).optional(),
  status: z.enum(schema.TRANSACTION_STATUSES).optional(),
  // Provider extras are best-effort: an invalid value is dropped, it never rejects the row.
  transactionDate: isoDate.optional().catch(undefined),
  occurredAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
  mcc: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .catch(undefined),
  details: z
    .custom<TransactionDetails>(() => true)
    .transform((v) => parseTransactionDetails(v))
    .optional(),
});
const metaSchema = z.strictObject({
  source: z.enum(['connector', 'import']),
  importBatchId: z.string().optional(),
});

export type IngestRow = z.input<typeof ingestRowSchema>;
export type IngestMeta = z.input<typeof metaSchema>;
export type IngestResult = {
  inserted: number;
  duplicates: number;
  pendingReplaced: number;
  insertedIds: string[];
};

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function shiftDate(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Runs rules, then merchant memory, then flags the rest for review (see categorizeInTx). */
export async function categorizeTransactions(
  ctx: ServiceCtx,
  ids: string[],
): Promise<CategorisationResult> {
  assertCanWrite(ctx);
  const valid = ids.filter((id) => {
    try {
      assertUuid(id, 'Transaction');
      return true;
    } catch {
      return false;
    }
  });
  return withHousehold(ctx.db, ctx.householdId, (tx) => categorizeInTx(tx, ctx.householdId, valid));
}

type PoolLeg = {
  id: string;
  accountId: string;
  bookingDate: string;
  amount: number;
  currency: string;
  categoryId: string | null;
  categorisedBy: string | null;
  needsReview: boolean;
  text: string;
  /** A Trading 212-style deposit or withdrawal: a transfer by nature. */
  platform: boolean;
};

/**
 * Legs that may be paired. An uncategorised leg always is. A leg that a rule, memory or the AI
 * categorised (before its counter-leg arrived) only when
 *  - its own text names the account on the other side or says it is a transfer ("To Trading 212",
 *    "top up"), or the partner's text names this leg's account ("Received from Everyday"), or
 *  - it is an investment platform deposit/withdrawal, or
 *  - the AI was not confident about it (it is still in the review inbox):
 * equal amounts alone would pair a confident card payment with an unrelated deposit.
 */
function pairableLegs(
  legs: PoolLeg[],
  accounts: Map<string, { name: string; institutionName: string | null; type: string }>,
): PoolLeg[] {
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
  return legs.filter(
    (c) =>
      c.categoryId === null ||
      legs.some((p) => {
        const other = accounts.get(p.accountId);
        const own = accounts.get(c.accountId);
        return (
          other !== undefined &&
          p.amount === -c.amount &&
          p.currency === c.currency &&
          p.accountId !== c.accountId &&
          Math.abs(day(p.bookingDate) - day(c.bookingDate)) <= TRANSFER_WINDOW_DAYS &&
          (c.platform ||
            (c.categorisedBy === 'ai' && c.needsReview) ||
            referencesOtherAccount(c.text, other) ||
            (own !== undefined && namesAccount(p.text, own)))
        );
      }),
  );
}

async function matchTransfersInTx(
  tx: Tx,
  householdId: string,
  since: string,
): Promise<{ paired: number; ambiguous: number }> {
  // Pairing reads then writes: serialise it per household so two ingests cannot grab one leg.
  await lockTransfers(tx, householdId);
  const rows = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      bookingDate: transaction.bookingDate,
      amount: transaction.amount,
      currency: transaction.currency,
      categoryId: transaction.categoryId,
      categorisedBy: transaction.categorisedBy,
      needsReview: transaction.needsReview,
      rawDescription: transaction.rawDescription,
      counterparty: transaction.counterparty,
      details: transaction.details,
    })
    .from(transaction)
    .where(transferCandidateFilter(householdId, since));
  const accounts = new Map(
    (
      await tx
        .select({
          id: financialAccount.id,
          name: financialAccount.name,
          institutionName: financialAccount.institutionName,
          type: financialAccount.type,
        })
        .from(financialAccount)
        .where(eq(financialAccount.householdId, householdId))
    ).map((acc) => [acc.id, acc]),
  );
  const candidates = pairableLegs(
    rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      bookingDate: r.bookingDate,
      amount: r.amount,
      currency: r.currency,
      categoryId: r.categoryId,
      categorisedBy: r.categorisedBy,
      needsReview: r.needsReview,
      text: `${r.rawDescription} ${r.counterparty ?? ''}`,
      platform: isPlatformTransferLeg({
        rawDescription: r.rawDescription,
        providerType: parseTransactionDetails(r.details)?.providerType ?? null,
        accountType: accounts.get(r.accountId)?.type ?? '',
      }),
    })),
    accounts,
  );
  const categorised = new Set(candidates.filter((c) => c.categoryId !== null).map((c) => c.id));
  const found = findTransferPairs(candidates, { windowDays: TRANSFER_WINDOW_DAYS });
  // Only an uncategorised leg is sent to review: a categorised one is already placed.
  const ambiguous = found.ambiguous.filter((id) => !categorised.has(id));
  let paired = 0;
  if (found.pairs.length > 0) {
    const categoryId = await ensureTransferCategory(tx, householdId);
    for (const pair of found.pairs) {
      try {
        await linkTransferLegs(tx, householdId, pair, categoryId, 'rule');
        paired += 1;
      } catch (error) {
        // A leg was taken meanwhile: leave this pair for a human.
        if (!(error instanceof TransferLinkConflictError)) throw error;
        ambiguous.push(...pair.filter((id) => !categorised.has(id)));
      }
    }
  }
  for (const idChunk of chunks(ambiguous, ID_CHUNK)) {
    await tx
      .update(transaction)
      .set({ needsReview: true })
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, idChunk)));
  }
  return { paired, ambiguous: ambiguous.length };
}

/**
 * Pairs equal-and-opposite uncategorised booked rows on different accounts, booked within a few
 * days of each other, from `since` onwards (default: the last 60 days). Paired legs share a
 * random transfer group and get the "between accounts" category; legs with several possible
 * partners stay unlinked and are flagged for review.
 */
export async function matchTransfers(
  ctx: ServiceCtx,
  opts: { since?: string } = {},
): Promise<{ paired: number; ambiguous: number }> {
  assertCanWrite(ctx);
  const { since } = parseInput(z.strictObject({ since: isoDate.optional() }), opts);
  const from =
    since ??
    new Date(Date.now() - DEFAULT_TRANSFER_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    matchTransfersInTx(tx, ctx.householdId, from),
  );
}

const DEFAULT_REPAIR_DAYS = 30;

/**
 * Repair sweep: runs the same matching as ingest over the last `days` days (default 30) of every
 * household, so legs that arrived apart (before late matching existed, or while a leg was still
 * pending) get linked. Idempotent: linked legs are never candidates again. A household that
 * fails does not stop the others; its id is returned in `failed` (the caller logs it).
 */
export async function matchTransfersForAllHouseholds(
  db: Db,
  opts: { days?: number } = {},
): Promise<{ households: number; paired: number; ambiguous: number; failed: string[] }> {
  const { days } = parseInput(
    z.strictObject({ days: z.number().int().min(1).max(365).optional() }),
    opts,
  );
  const since = shiftDate(new Date().toISOString().slice(0, 10), -(days ?? DEFAULT_REPAIR_DAYS));
  const households = await db.select({ id: schema.organization.id }).from(schema.organization);
  const out = { households: households.length, paired: 0, ambiguous: 0, failed: [] as string[] };
  for (const { id } of households) {
    try {
      const r = await withHousehold(db, id, (tx) => matchTransfersInTx(tx, id, since));
      out.paired += r.paired;
      out.ambiguous += r.ambiguous;
    } catch {
      out.failed.push(id);
    }
  }
  return out;
}

/**
 * Stores bank rows for one account, then categorises them and pairs transfers, all in one
 * transaction (a failure leaves nothing behind). Shared by file imports and, in Phase 2, sync.
 *
 *  - Rows repeated within the batch get an occurrence number, so genuine repeats survive while
 *    re-importing the same or an overlapping file inserts nothing (`dedupe_hash`, plus
 *    `external_id` when the source provides one).
 *  - A booked row whose `externalId` matches a pending row replaces it in place: the id and the
 *    user's edits (notes, and the category when the user chose it) are kept; automatic
 *    categorisation is re-run because the description may have changed.
 *  - Without an `externalId` (on both rows) a booked row replaces a pending one only when the data is identical
 *    (same dedupe hash). If the amount, date or description changed between pending and booked
 *    there is nothing to match on: the pending row is left as it is (nothing expires it, e.g.
 *    after 10 days) and the booked row is inserted next to it for the user to tidy up.
 */
export async function ingestTransactions(
  ctx: ServiceCtx,
  accountId: string,
  rawRows: IngestRow[],
  rawMeta: IngestMeta,
): Promise<IngestResult> {
  assertCanWrite(ctx);
  assertUuid(accountId, 'Account');
  const meta = parseInput(metaSchema, rawMeta);
  if (rawRows.length > MAX_ROWS_PER_CALL) {
    throw new ValidationError(`Too many rows in one call (maximum ${MAX_ROWS_PER_CALL})`);
  }
  const rows = parseInput(z.array(ingestRowSchema), rawRows);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    ingestRowsInTx(tx, ctx, accountId, rows, meta),
  );
}

/**
 * Gives each row its default status and its dedupe hash, numbering repeats within the batch.
 * Shared by ingest and the import preview so both count duplicates the same way.
 */
export function keyRowsForDedupe<R extends z.output<typeof ingestRowSchema>>(
  accountId: string,
  rows: R[],
) {
  return assignOccurrences(rows, (r) =>
    dedupeKey({
      accountId,
      bookingDate: r.bookingDate,
      amount: r.amount,
      description: r.description,
    }),
  ).map((r) => ({
    ...r,
    status: r.status ?? ('booked' as const),
    dedupeHash: dedupeHash({
      accountId,
      bookingDate: r.bookingDate,
      amount: r.amount,
      description: r.description,
      occurrence: r.occurrence,
    }),
  }));
}

type DetailRow = Pick<
  z.output<typeof ingestRowSchema>,
  'externalId' | 'transactionDate' | 'occurredAt' | 'mcc' | 'details'
>;

/**
 * Columns for a pending row that has just been booked: what the booked row brings replaces the
 * pending value, anything it lacks is kept; `details` is merged key by key (so keys written
 * later, such as the location, survive; see `mergeDetailsSql`).
 */
function detailsOnReplace(r: DetailRow) {
  return {
    ...(r.transactionDate ? { transactionDate: r.transactionDate } : {}),
    ...(r.occurredAt ? { occurredAt: new Date(r.occurredAt) } : {}),
    ...(r.mcc ? { mcc: r.mcc } : {}),
    ...(r.details ? { details: mergeDetailsSql(transaction.details, r.details) } : {}),
  };
}

/**
 * Fills the provider extras of rows that already exist under the same `(account, external_id)`:
 * a column is written only while it is null, so stored values, user edits and the dedupe key are
 * never touched. Not an insert, so it does not change the ingest counts.
 */
async function backfillDetailsInTx(
  tx: Tx,
  householdId: string,
  accountId: string,
  existing: DetailRow[],
): Promise<void> {
  const seen = new Set<string>();
  const rows = existing.filter((r) => {
    const hasData = r.transactionDate || r.occurredAt || r.mcc || r.details;
    if (!hasData || seen.has(r.externalId!)) return false;
    seen.add(r.externalId!);
    return true;
  });
  for (const chunk of chunks(rows, INSERT_CHUNK)) {
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${r.externalId}::text, ${r.transactionDate ?? null}::date, ${r.occurredAt ?? null}::timestamptz, ${r.mcc ?? null}::text, ${r.details ? JSON.stringify(r.details) : null}::jsonb)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      update "transaction" t set
        transaction_date = coalesce(t.transaction_date, v.transaction_date),
        occurred_at = coalesce(t.occurred_at, v.occurred_at),
        mcc = coalesce(t.mcc, v.mcc),
        details = coalesce(t.details, v.details)
      from (values ${values}) as v(external_id, transaction_date, occurred_at, mcc, details)
      where t.household_id = ${householdId} and t.account_id = ${accountId}
        and t.external_id = v.external_id
        and ((t.transaction_date is null and v.transaction_date is not null)
          or (t.occurred_at is null and v.occurred_at is not null)
          or (t.mcc is null and v.mcc is not null)
          or (t.details is null and v.details is not null))`);
  }
}

/**
 * A new row with an external id normally dedupes against stored rows by hash too (a file import
 * and the bank feed describe the same transaction; a provider may also reissue an id). The one
 * exception is a hash collision that cannot be the same row. The provider lists newest first, so
 * a later sync can number a new identical row 0 and collide with the stored one. The row moves
 * to the next free occurrence only when the hash holder
 *  - is another row of this incoming batch, or
 *  - has an external id that this batch lists as well (the provider reports both rows now), or
 *  - is a connector pending row and the incoming row is booked (the pending one is expired later).
 * Every other collision still means "same row" and the row is skipped on insert. Stored hashes
 * never change. One query per round covers every row still in question.
 */
export async function rekeyCollidingExternalRows<
  R extends ReturnType<typeof keyRowsForDedupe>[number],
>(tx: Tx, householdId: string, accountId: string, rows: R[], batchRows: R[] = rows): Promise<R[]> {
  const withId = rows.filter((r) => r.externalId);
  if (withId.length === 0) return rows;
  const batchIds = new Set(batchRows.flatMap((r) => (r.externalId ? [r.externalId] : [])));
  const known = new Set<string>();
  for (const idChunk of chunks([...batchIds], ID_CHUNK)) {
    const found = await tx
      .select({ externalId: transaction.externalId })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, householdId),
          eq(transaction.accountId, accountId),
          inArray(transaction.externalId, idChunk),
        ),
      );
    for (const f of found) known.add(f.externalId!);
  }
  // Rows already stored under their external id are skipped on insert: they take no hash.
  const fresh = withId.filter((r) => !known.has(r.externalId!));
  const taken = new Set(
    rows.filter((r) => !r.externalId || !known.has(r.externalId)).map((r) => r.dedupeHash),
  );
  for (const r of fresh) taken.delete(r.dedupeHash);
  const current = new Map<R, R>(fresh.map((r) => [r, r]));
  let open = fresh;
  while (open.length > 0) {
    const holders = new Map<
      string,
      { externalId: string | null; status: string; source: string }
    >();
    const hashes = [...new Set(open.map((r) => current.get(r)!.dedupeHash))];
    for (const part of chunks(hashes, ID_CHUNK)) {
      const found = await tx
        .select({
          hash: transaction.dedupeHash,
          externalId: transaction.externalId,
          status: transaction.status,
          source: transaction.source,
        })
        .from(transaction)
        .where(
          and(
            eq(transaction.householdId, householdId),
            eq(transaction.accountId, accountId),
            inArray(transaction.dedupeHash, part),
          ),
        );
      for (const f of found) holders.set(f.hash, f);
    }
    const bumped: R[] = [];
    for (const r of open) {
      const row = current.get(r)!;
      const holder = holders.get(row.dedupeHash);
      const collides =
        taken.has(row.dedupeHash) ||
        (holder !== undefined &&
          holder.externalId !== null &&
          (batchIds.has(holder.externalId) ||
            (holder.status === 'pending' &&
              holder.source === 'connector' &&
              row.status === 'booked')));
      if (!collides) {
        taken.add(row.dedupeHash);
        continue;
      }
      const occurrence = row.occurrence + 1;
      current.set(r, {
        ...row,
        occurrence,
        dedupeHash: dedupeHash({
          accountId,
          bookingDate: row.bookingDate,
          amount: row.amount,
          description: row.description,
          occurrence,
        }),
      });
      bumped.push(r);
    }
    open = bumped;
  }
  return rows.map((r) => current.get(r) ?? r);
}

/**
 * One ingest per account at a time: concurrent overlapping files then see each other's rows as
 * duplicates instead of racing on the unique indexes. Held until the transaction ends.
 */
export async function lockAccountIngest(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ingest:${accountId}`}, 0))`,
  );
}

/**
 * The body of ingestTransactions for callers that already hold a household transaction (the file
 * import creates its batch in the same transaction). `rows` and `meta` must already be validated.
 */
export async function ingestRowsInTx(
  tx: Tx,
  ctx: ServiceCtx,
  accountId: string,
  rows: z.output<typeof ingestRowSchema>[],
  meta: z.output<typeof metaSchema>,
): Promise<IngestResult> {
  const empty: IngestResult = { inserted: 0, duplicates: 0, pendingReplaced: 0, insertedIds: [] };
  await lockAccountIngest(tx, accountId);
  // Lock order is account -> transfers -> row locks; pairing at the end needs the lock anyway.
  await lockTransfers(tx, ctx.householdId);
  const [account] = await tx
    .select()
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    );
  if (!account) throw new NotFoundError('Account');
  if (account.archivedAt) throw new ValidationError('Account is archived');
  if (meta.importBatchId !== undefined) {
    assertUuid(meta.importBatchId, 'Import batch');
    const [batch] = await tx
      .select({ id: importBatch.id })
      .from(importBatch)
      .where(
        and(eq(importBatch.id, meta.importBatchId), eq(importBatch.householdId, ctx.householdId)),
      );
    if (!batch) throw new NotFoundError('Import batch');
  }
  if (rows.some((r) => r.currency !== account.currency)) {
    throw new ValidationError(`Rows must be in the account currency (${account.currency})`);
  }
  if (rows.length === 0) return empty;

  const keyed = keyRowsForDedupe(accountId, rows);

  // Pending -> booked, matched by external id (first row per id wins).
  const bookedWithId = new Map<string, (typeof keyed)[number]>();
  for (const r of keyed) {
    if (r.externalId && r.status === 'booked' && !bookedWithId.has(r.externalId)) {
      bookedWithId.set(r.externalId, r);
    }
  }
  const replacedIds: string[] = [];
  const replacedExternalIds = new Set<string>();
  for (const idChunk of chunks([...bookedWithId.keys()], ID_CHUNK)) {
    const pending = await tx
      .select({ id: transaction.id, externalId: transaction.externalId })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.accountId, accountId),
          eq(transaction.status, 'pending'),
          inArray(transaction.externalId, idChunk),
        ),
      );
    for (const p of pending) {
      const booked = bookedWithId.get(p.externalId!)!;
      await tx
        .update(transaction)
        .set({
          status: 'booked',
          // The booked row now belongs to the newest import (undoing it deletes the row).
          ...(meta.importBatchId ? { importBatchId: meta.importBatchId } : {}),
          bookingDate: booked.bookingDate,
          valueDate: booked.valueDate ?? null,
          amount: booked.amount,
          currency: booked.currency,
          rawDescription: booked.description,
          counterparty: booked.counterparty ?? null,
          ...detailsOnReplace(booked),
          // Keep the pending row's hash if the booked data already exists under another row.
          dedupeHash: sql`case when exists (
            select 1 from "transaction" o
            where o.account_id = ${accountId} and o.dedupe_hash = ${booked.dedupeHash} and o.id <> ${p.id}
          ) then ${transaction.dedupeHash} else ${booked.dedupeHash} end`,
        })
        .where(eq(transaction.id, p.id));
      replacedIds.push(p.id);
      replacedExternalIds.add(p.externalId!);
    }
  }

  // Pending -> booked without external ids on either side: identical data (same dedupe hash)
  // is the same row.
  const consumed = new Set<(typeof keyed)[number]>(
    [...bookedWithId.values()].filter((r) => replacedExternalIds.has(r.externalId!)),
  );
  const bookedByHash = new Map<string, (typeof keyed)[number]>();
  for (const r of keyed) {
    if (
      r.status === 'booked' &&
      !r.externalId &&
      !consumed.has(r) &&
      !bookedByHash.has(r.dedupeHash)
    ) {
      bookedByHash.set(r.dedupeHash, r);
    }
  }
  for (const hashChunk of chunks([...bookedByHash.keys()], ID_CHUNK)) {
    const pending = await tx
      .select({ id: transaction.id, dedupeHash: transaction.dedupeHash })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.accountId, accountId),
          eq(transaction.status, 'pending'),
          isNull(transaction.externalId),
          inArray(transaction.dedupeHash, hashChunk),
        ),
      );
    for (const p of pending) {
      const booked = bookedByHash.get(p.dedupeHash)!;
      await tx
        .update(transaction)
        .set({
          status: 'booked',
          ...(meta.importBatchId ? { importBatchId: meta.importBatchId } : {}),
          valueDate: booked.valueDate ?? null,
          rawDescription: booked.description,
          counterparty: booked.counterparty ?? null,
          ...detailsOnReplace(booked),
        })
        .where(eq(transaction.id, p.id));
      replacedIds.push(p.id);
      consumed.add(booked);
    }
  }

  const toInsert = await rekeyCollidingExternalRows(
    tx,
    ctx.householdId,
    accountId,
    keyed.filter((r) => !consumed.has(r)),
    keyed,
  );
  const insertedIds: string[] = [];
  for (const batch of chunks(toInsert, INSERT_CHUNK)) {
    const created = await tx
      .insert(transaction)
      .values(
        batch.map((r) => ({
          householdId: ctx.householdId,
          accountId,
          externalId: r.externalId ?? null,
          dedupeHash: r.dedupeHash,
          bookingDate: r.bookingDate,
          valueDate: r.valueDate ?? null,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          rawDescription: r.description,
          counterparty: r.counterparty ?? null,
          transactionDate: r.transactionDate ?? null,
          occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
          mcc: r.mcc ?? null,
          details: r.details ?? null,
          source: meta.source,
          importBatchId: meta.importBatchId ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: transaction.id, externalId: transaction.externalId });
    insertedIds.push(...created.map((c) => c.id));
    const inserted = new Set(created.map((c) => c.externalId));
    await backfillDetailsInTx(
      tx,
      ctx.householdId,
      accountId,
      batch.filter((r) => r.externalId && !inserted.has(r.externalId)),
    );
  }

  const uniqueReplaced = [...new Set(replacedIds)];
  const result: IngestResult = {
    inserted: insertedIds.length,
    duplicates: Math.max(0, rows.length - insertedIds.length - uniqueReplaced.length),
    pendingReplaced: uniqueReplaced.length,
    insertedIds,
  };
  const touched = [...uniqueReplaced, ...insertedIds];
  if (touched.length === 0) return result;

  await categorizeInTx(tx, ctx.householdId, touched);
  // A leg can pair with a row up to the window earlier than the oldest row of this batch.
  const oldest = rows.reduce(
    (min, r) => (r.bookingDate < min ? r.bookingDate : min),
    rows[0]!.bookingDate,
  );
  await matchTransfersInTx(tx, ctx.householdId, shiftDate(oldest, -TRANSFER_WINDOW_DAYS));
  return result;
}

/**
 * After a fully successful bank sync of one account: deletes the account's connector pending
 * rows, from `from` onwards, that the provider no longer returned (as pending or booked under
 * the same external id, or, without one, with the same dedupe hash). A pending row whose booked
 * version arrived under another identity would otherwise stay for ever, counted in lists, budgets
 * and the review count next to it. Rows a person touched (notes, category) are kept. Returns how
 * many were deleted.
 */
export async function expireVanishedPending(
  ctx: ServiceCtx,
  accountId: string,
  rawReturned: IngestRow[],
  from: string,
): Promise<number> {
  assertCanWrite(ctx);
  assertUuid(accountId, 'Account');
  const returned = keyRowsForDedupe(accountId, parseInput(z.array(ingestRowSchema), rawReturned));
  const externalIds = new Set(returned.flatMap((r) => (r.externalId ? [r.externalId] : [])));
  const hashes = new Set(returned.map((r) => r.dedupeHash));
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockAccountIngest(tx, accountId);
    const stale = await tx
      .select({
        id: transaction.id,
        externalId: transaction.externalId,
        dedupeHash: transaction.dedupeHash,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.accountId, accountId),
          eq(transaction.status, 'pending'),
          eq(transaction.source, 'connector'),
          isNull(transaction.userEditedAt),
          isNull(transaction.transferGroupId),
          gte(transaction.bookingDate, from),
        ),
      );
    const ids = stale
      .filter((r) => !(r.externalId ? externalIds.has(r.externalId) : hashes.has(r.dedupeHash)))
      .map((r) => r.id);
    for (const idChunk of chunks(ids, ID_CHUNK)) {
      await tx
        .delete(transaction)
        .where(and(eq(transaction.householdId, ctx.householdId), inArray(transaction.id, idChunk)));
    }
    return ids.length;
  });
}
