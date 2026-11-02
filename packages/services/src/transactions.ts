import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { merchantKey, parseTransactionDetails, type TransactionDetails } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  resolveTemplateLocale,
  seedTemplatesInTx,
  TRANSFER_CATEGORY_KEY,
} from './category-templates.js';
import {
  assertCanWrite,
  assertUuid,
  ConflictError,
  isoDate,
  NotFoundError,
  parseInput,
  ValidationError,
  type WriteOpts,
  type ServiceCtx,
} from './context.js';
import { AI_MAX_ATTEMPTS } from './ai/categorise.js';
import { categorizeInTx, createRuleInTx, requireUsableCategory, ruleDraftOf } from './rules.js';

const {
  category,
  financialAccount,
  householdSettings,
  merchant,
  merchantLogo,
  transaction,
  undoToken,
} = schema;

const UNDO_TTL_MS = 15 * 60_000;

export type TransactionRow = typeof transaction.$inferSelect;
/** The merchant a row is linked to; `hasLogo` says whether `/api/merchants/<id>/logo` has an image. */
export type TransactionMerchant = {
  id: string;
  name: string;
  domain: string | null;
  hasLogo: boolean;
};
/** City and/or country (ISO alpha-2) of the transaction, from `details.location`. */
export type TransactionLocation = NonNullable<TransactionDetails['location']>;
/** List rows leave out `details` (up to a few KB each): `getTransaction` returns it. */
export type TransactionListRow = Omit<TransactionRow, 'details'> & {
  merchant: TransactionMerchant | null;
  location: TransactionLocation | null;
};
export type TransactionPage = { items: TransactionListRow[]; nextCursor: string | null };

const allColumns = getTableColumns(transaction);
const listColumns = Object.fromEntries(
  Object.entries(allColumns).filter(([name]) => name !== 'details'),
) as Omit<typeof allColumns, 'details'>;

/** The joined columns every merchant-aware read selects next to the transaction columns. */
const merchantSelect = {
  merchantName: merchant.displayName,
  merchantNameSource: merchant.nameSource,
  merchantDomain: merchant.domain,
  logoStatus: merchantLogo.status,
  rawLocation: sql<unknown>`${transaction.details}->'location'`,
};

function merchantFields(r: {
  merchantId: string | null;
  merchantName: string | null;
  merchantNameSource: string | null;
  merchantDomain: string | null;
  logoStatus: string | null;
  rawLocation: unknown;
}): { merchant: TransactionMerchant | null; location: TransactionLocation | null } {
  return {
    merchant:
      // A merchant the memory created from raw text has no friendly name (no name source) yet.
      r.merchantId && r.merchantName !== null && r.merchantNameSource !== null
        ? {
            id: r.merchantId,
            name: r.merchantName,
            domain: r.merchantDomain,
            hasLogo: r.logoStatus === 'ok',
          }
        : null,
    location: parseTransactionDetails({ location: r.rawLocation })?.location ?? null,
  };
}

/**
 * The `merchant` and `location` fields of the given rows, in one query. Write operations return
 * the raw row; callers that hand a DTO to the UI add these so an edit does not blank them.
 * Unknown ids and other households' rows are simply absent from the map.
 */
export async function merchantFieldsFor(
  ctx: ServiceCtx,
  ids: string[],
): Promise<
  Map<string, { merchant: TransactionMerchant | null; location: TransactionLocation | null }>
> {
  const valid = ids.filter((id) => z.uuid().safeParse(id).success);
  if (valid.length === 0) return new Map();
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select({ id: transaction.id, merchantId: transaction.merchantId, ...merchantSelect })
      .from(transaction)
      .leftJoin(
        merchant,
        and(
          eq(merchant.id, transaction.merchantId),
          eq(merchant.householdId, transaction.householdId),
        ),
      )
      .leftJoin(
        merchantLogo,
        and(
          eq(merchantLogo.merchantId, merchant.id),
          eq(merchantLogo.householdId, merchant.householdId),
        ),
      )
      .where(and(eq(transaction.householdId, ctx.householdId), inArray(transaction.id, valid)));
    return new Map(rows.map((r) => [r.id, merchantFields(r)]));
  });
}

export const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------------------------
// Listing

const listSchema = z.strictObject({
  accountIds: z.array(z.uuid()).max(100).optional(),
  categoryIds: z.array(z.uuid()).max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(200).optional(),
  needsReview: z.boolean().optional(),
  /** Only booked or pending rows with no category that are not part of a transfer. */
  uncategorised: z.boolean().optional(),
  /** Only rows whose category the AI applied. */
  categorisedBy: z.literal('ai').optional(),
  direction: z.enum(['in', 'out']).optional(),
  status: z.enum(['pending', 'booked']).optional(),
  /** Leave out transfers (a transfer group or the transfer category), as analytics does. */
  excludeTransfers: z.boolean().optional(),
  /** Only transfers (a transfer group or the transfer category): the opposite of the above. */
  transfersOnly: z.boolean().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).optional(),
});

export type ListTransactionsOptions = z.input<typeof listSchema>;

function encodeCursor(row: Pick<TransactionRow, 'purchaseDate' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.purchaseDate, row.id])).toString('base64url');
}

function decodeCursor(cursor: string): { purchaseDate: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const [purchaseDate, id] = z.tuple([isoDate, z.uuid()]).parse(parsed);
    return { purchaseDate, id };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

/** Escapes LIKE metacharacters so user text matches literally (escape char is a backslash). */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Shared by the transaction list and the review inbox. Ordered `purchase_date desc, id`. */
export async function queryTransactions(
  tx: Tx,
  ctx: ServiceCtx,
  rawOpts: ListTransactionsOptions,
): Promise<TransactionPage> {
  const opts = parseInput(listSchema, rawOpts);
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const conditions: Array<SQL | undefined> = [eq(transaction.householdId, ctx.householdId)];
  if (opts.accountIds?.length) conditions.push(inArray(transaction.accountId, opts.accountIds));
  if (opts.categoryIds?.length) conditions.push(inArray(transaction.categoryId, opts.categoryIds));
  if (opts.from) conditions.push(gte(transaction.purchaseDate, opts.from));
  if (opts.to) conditions.push(lte(transaction.purchaseDate, opts.to));
  if (opts.needsReview !== undefined)
    conditions.push(eq(transaction.needsReview, opts.needsReview));
  if (opts.uncategorised) {
    conditions.push(isNull(transaction.categoryId), isNull(transaction.transferGroupId));
  }
  if (opts.categorisedBy) conditions.push(eq(transaction.categorisedBy, opts.categorisedBy));
  if (opts.direction === 'in') conditions.push(gt(transaction.amount, 0));
  if (opts.direction === 'out') conditions.push(lt(transaction.amount, 0));
  if (opts.status) conditions.push(eq(transaction.status, opts.status));
  if (opts.excludeTransfers) {
    conditions.push(notTransferFilter(await findTransferCategory(tx, ctx.householdId)));
  }
  if (opts.transfersOnly) {
    conditions.push(not(notTransferFilter(await findTransferCategory(tx, ctx.householdId))));
  }
  if (opts.search) {
    const pattern = likePattern(opts.search);
    conditions.push(
      or(
        sql`${transaction.rawDescription} ilike ${pattern} escape '\\'`,
        sql`${transaction.counterparty} ilike ${pattern} escape '\\'`,
        sql`${transaction.notes} ilike ${pattern} escape '\\'`,
        // Only a real friendly name (AI or user), not the raw text the memory remembered.
        and(
          isNotNull(merchant.nameSource),
          sql`${merchant.displayName} ilike ${pattern} escape '\\'`,
        ),
      ),
    );
  }
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    conditions.push(
      or(
        lt(transaction.purchaseDate, c.purchaseDate),
        and(eq(transaction.purchaseDate, c.purchaseDate), gt(transaction.id, c.id)),
      ),
    );
  }
  // One query: the merchant and its logo status come from left joins (no bytes are read), and
  // only `details.location` is taken out of the JSON.
  const rows = await tx
    .select({ ...listColumns, ...merchantSelect })
    .from(transaction)
    .leftJoin(
      merchant,
      and(
        eq(merchant.id, transaction.merchantId),
        eq(merchant.householdId, transaction.householdId),
      ),
    )
    .leftJoin(
      merchantLogo,
      and(
        eq(merchantLogo.merchantId, merchant.id),
        eq(merchantLogo.householdId, merchant.householdId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(transaction.purchaseDate), transaction.id)
    .limit(limit + 1)
    .then((found) =>
      found.map(
        ({
          merchantName,
          merchantNameSource,
          merchantDomain,
          logoStatus,
          rawLocation,
          ...row
        }) => ({
          ...row,
          ...merchantFields({
            merchantId: row.merchantId,
            merchantName,
            merchantNameSource,
            merchantDomain,
            logoStatus,
            rawLocation,
          }),
        }),
      ),
    );
  const items: TransactionListRow[] = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

export async function listTransactions(
  ctx: ServiceCtx,
  opts: ListTransactionsOptions = {},
): Promise<TransactionPage> {
  return withHousehold(ctx.db, ctx.householdId, (tx) => queryTransactions(tx, ctx, opts));
}

async function requireTransaction(tx: Tx, ctx: ServiceCtx, id: string): Promise<TransactionRow> {
  assertUuid(id, 'Transaction');
  const [row] = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.id, id), eq(transaction.householdId, ctx.householdId)));
  if (!row) throw new NotFoundError('Transaction');
  return row;
}

export type TransferPartner = {
  id: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  amount: number;
  currency: string;
  counterparty: string | null;
  rawDescription: string;
};
/** `details` is re-validated on the way out, so a malformed stored value reads as null. */
export type TransactionDetail = Omit<TransactionRow, 'details'> & {
  details: TransactionDetails | null;
  merchant: TransactionMerchant | null;
  location: TransactionLocation | null;
  transferPartner: TransferPartner | null;
};

/** One transaction; when it is a transfer leg, also the other leg (`transferPartner`). */
export async function getTransaction(ctx: ServiceCtx, id: string): Promise<TransactionDetail> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const row = await requireTransaction(tx, ctx, id);
    let transferPartner: TransferPartner | null = null;
    if (row.transferGroupId) {
      const [other] = await tx
        .select({
          id: transaction.id,
          accountId: transaction.accountId,
          accountName: financialAccount.name,
          bookingDate: transaction.bookingDate,
          amount: transaction.amount,
          currency: transaction.currency,
          counterparty: transaction.counterparty,
          rawDescription: transaction.rawDescription,
        })
        .from(transaction)
        .innerJoin(
          financialAccount,
          and(
            eq(financialAccount.id, transaction.accountId),
            eq(financialAccount.householdId, transaction.householdId),
          ),
        )
        .where(
          and(
            eq(transaction.householdId, ctx.householdId),
            eq(transaction.transferGroupId, row.transferGroupId),
            ne(transaction.id, row.id),
          ),
        )
        .limit(1);
      transferPartner = other ?? null;
    }
    let linked: TransactionMerchant | null = null;
    if (row.merchantId) {
      const [m] = await tx
        .select({
          name: merchant.displayName,
          nameSource: merchant.nameSource,
          domain: merchant.domain,
          logoStatus: merchantLogo.status,
        })
        .from(merchant)
        .leftJoin(
          merchantLogo,
          and(
            eq(merchantLogo.merchantId, merchant.id),
            eq(merchantLogo.householdId, merchant.householdId),
          ),
        )
        .where(and(eq(merchant.id, row.merchantId), eq(merchant.householdId, ctx.householdId)));
      // A merchant the memory created from a description has no friendly name yet.
      if (m?.nameSource) {
        linked = {
          id: row.merchantId,
          name: m.name,
          domain: m.domain,
          hasLogo: m.logoStatus === 'ok',
        };
      }
    }
    const details = parseTransactionDetails(row.details) ?? null;
    return {
      ...row,
      details,
      merchant: linked,
      location: details?.location ?? null,
      transferPartner,
    };
  });
}

export type TransferCandidateOptions = {
  windowDays?: number;
  /**
   * Include rows (and a source row) a user marked or unlinked. `transfer_locked` only stops
   * AUTOMATIC pairing and the review hints; a person choosing a counterpart by hand may use them.
   */
  includeLocked?: boolean;
};

const MAX_CANDIDATE_SOURCES = 200;
const MAX_CANDIDATES_PER_ROW = 10;

/**
 * Rows that could be the other leg of each of `ids`, in one query: opposite amount, same currency,
 * another account, not linked, within `windowDays`, nearest date first (max 10 each). Rows that are
 * missing, linked or without candidates map to an empty list.
 */
export async function findTransferCandidatesFor(
  ctx: ServiceCtx,
  ids: string[],
  opts: TransferCandidateOptions = {},
): Promise<Map<string, TransactionRow[]>> {
  const list = parseInput(z.array(z.uuid()).max(MAX_CANDIDATE_SOURCES), ids);
  const windowDays = Math.min(Math.max(Math.trunc(opts.windowDays ?? 5), 0), 60);
  const includeLocked = opts.includeLocked ?? false;
  const out = new Map<string, TransactionRow[]>(list.map((id) => [id, []]));
  if (list.length === 0) return out;
  const cand = alias(transaction, 'cand');
  const distance = sql<number>`abs(${cand.bookingDate} - ${transaction.bookingDate})`;
  const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ sourceId: transaction.id, candidate: getTableColumns(cand) })
      .from(transaction)
      .innerJoin(
        cand,
        and(
          eq(cand.householdId, transaction.householdId),
          eq(cand.amount, sql`-${transaction.amount}`),
          eq(cand.currency, transaction.currency),
          ne(cand.accountId, transaction.accountId),
          isNull(cand.transferGroupId),
          includeLocked ? undefined : eq(cand.transferLocked, false),
          sql`${distance} <= ${windowDays}`,
        ),
      )
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          inArray(transaction.id, list),
          isNull(transaction.transferGroupId),
          ne(transaction.amount, 0),
          includeLocked ? undefined : eq(transaction.transferLocked, false),
        ),
      )
      .orderBy(transaction.id, asc(distance), cand.id),
  );
  for (const r of rows) {
    const bucket = out.get(r.sourceId)!;
    if (bucket.length < MAX_CANDIDATES_PER_ROW) bucket.push(r.candidate);
  }
  return out;
}

/** Candidates for one row (see `findTransferCandidatesFor`); 404 when the row does not exist. */
export async function findTransferCandidates(
  ctx: ServiceCtx,
  id: string,
  opts: TransferCandidateOptions = {},
): Promise<TransactionRow[]> {
  await withHousehold(ctx.db, ctx.householdId, (tx) => requireTransaction(tx, ctx, id));
  return (await findTransferCandidatesFor(ctx, [id], opts)).get(id) ?? [];
}

/**
 * "This is not a transfer": locks both rows against automatic pairing (and the review hint), so
 * the suggestion never comes back. A person can still link them by hand with `markTransfer`.
 */
export async function dismissTransferHint(
  ctx: ServiceCtx,
  idA: string,
  idB: string,
): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(idA, 'Transaction');
  assertUuid(idB, 'Transaction');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockTransfers(tx, ctx.householdId);
    await requireTransaction(tx, ctx, idA);
    await requireTransaction(tx, ctx, idB);
    await tx
      .update(transaction)
      .set({ transferLocked: true })
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          inArray(transaction.id, [idA, idB]),
          isNull(transaction.transferGroupId),
        ),
      );
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with the pipeline

export async function findTransferCategory(
  tx: Tx,
  householdId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: category.id })
    .from(category)
    .where(
      and(eq(category.householdId, householdId), eq(category.templateKey, TRANSFER_CATEGORY_KEY)),
    );
  return row?.id;
}

/**
 * Drizzle filter that keeps only non-transfer rows: no transfer group and not in the transfer
 * category. The one definition of "not a transfer" for analytics and the home summary.
 */
export function notTransferFilter(transferCategoryId: string | undefined): SQL {
  return and(
    isNull(transaction.transferGroupId),
    transferCategoryId
      ? or(isNull(transaction.categoryId), ne(transaction.categoryId, transferCategoryId))
      : undefined,
  )!;
}

/**
 * The id of the household's "between accounts" transfer category, seeding the templates (in the
 * household locale) if the household has none yet.
 */
export async function ensureTransferCategory(tx: Tx, householdId: string): Promise<string> {
  const existing = await findTransferCategory(tx, householdId);
  if (existing) return existing;
  const [settings] = await tx
    .select({ locale: householdSettings.locale })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  await seedTemplatesInTx(tx, householdId, resolveTemplateLocale(settings?.locale ?? 'en'));
  const seeded = await findTransferCategory(tx, householdId);
  if (!seeded) throw new Error('transfer category is missing after seeding templates');
  return seeded;
}

/** Raised when a leg is no longer free to link (another writer paired it first). */
export class TransferLinkConflictError extends Error {
  constructor() {
    super('A transfer leg is already linked');
    this.name = 'TransferLinkConflictError';
  }
}

/**
 * Serialises transfer pairing/marking per household. Held until the transaction ends. Lock order
 * is always: account ingest lock, then this lock, then row locks.
 */
export async function lockTransfers(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`transfers:${householdId}`}, 0))`,
  );
}

/**
 * Links legs into one transfer group with `categoryId` (the transfer category). Only still-free
 * legs are updated; if any is not, nothing stays changed (savepoint) and
 * TransferLinkConflictError is thrown.
 */
export async function linkTransferLegs(
  tx: Tx,
  householdId: string,
  legIds: string[],
  categoryId: string,
  by: 'user' | 'rule',
): Promise<string> {
  const transferGroupId = randomUUID();
  await tx.transaction(async (sp) => {
    const updated = await sp
      .update(transaction)
      .set({
        transferGroupId,
        categoryId,
        categorisedBy: by,
        confidence: null,
        needsReview: false,
        // An automatic pairing that replaces a memory/AI category keeps it, so unlinking can put
        // it back (Postgres evaluates SET expressions on the old row); otherwise any stale
        // suggestion is dropped, so a non-null value on a leg always means "category to restore".
        aiSuggestedCategoryId:
          by === 'rule'
            ? sql`case when ${transaction.categorisedBy} in ('ai', 'memory') then ${transaction.categoryId} end`
            : null,
        // Automatic pairing is not a user edit; a user mark is (and protects against re-pairing).
        ...(by === 'user' ? { userEditedAt: sql`now()`, transferLocked: true } : {}),
      })
      .where(
        and(
          eq(transaction.householdId, householdId),
          inArray(transaction.id, legIds),
          isNull(transaction.transferGroupId),
        ),
      )
      .returning({ id: transaction.id });
    if (updated.length !== legIds.length) throw new TransferLinkConflictError();
  });
  return transferGroupId;
}

/**
 * Dissolves a group: legs return to the review inbox without the transfer category. A user
 * unlink also locks the legs against automatic re-pairing; `byUser: false` (the other leg of a
 * deleted import) leaves them free to pair again later.
 */
export async function unlinkGroupInTx(
  tx: Tx,
  householdId: string,
  groupId: string,
  opts: { byUser: boolean } = { byUser: true },
): Promise<number> {
  await lockTransfers(tx, householdId);
  const legs = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.householdId, householdId), eq(transaction.transferGroupId, groupId)));
  if (legs.length === 0) return 0;
  const transferCategoryId = await ensureTransferCategory(tx, householdId);
  for (const leg of legs) {
    const wasTransferCategory = leg.categoryId === transferCategoryId;
    // The category an automatic pairing replaced (see linkTransferLegs), if it is still usable.
    let restoreId: string | null = null;
    if (wasTransferCategory && leg.aiSuggestedCategoryId) {
      const [usable] = await tx
        .select({ id: category.id })
        .from(category)
        .where(
          and(
            eq(category.id, leg.aiSuggestedCategoryId),
            eq(category.householdId, householdId),
            isNull(category.archivedAt),
          ),
        );
      restoreId = usable?.id ?? null;
    }
    await tx
      .update(transaction)
      .set({
        transferGroupId: null,
        needsReview: true,
        // A restored category is not a user edit: the row stays open to the AI like before.
        ...(opts.byUser
          ? { transferLocked: true, ...(restoreId ? {} : { userEditedAt: sql`now()` }) }
          : {}),
        ...(restoreId
          ? { categoryId: restoreId, categorisedBy: 'ai' as const, confidence: null }
          : wasTransferCategory
            ? { categoryId: null, categorisedBy: null, confidence: null }
            : {}),
        ...(wasTransferCategory ? { aiSuggestedCategoryId: null } : {}),
      })
      .where(eq(transaction.id, leg.id));
  }
  return legs.length;
}

// ---------------------------------------------------------------------------------------------
// Manual entry, edits, deletion

const manualSchema = z.strictObject({
  accountId: z.string(),
  bookingDate: isoDate,
  valueDate: isoDate.optional(),
  amount: z.number().int().safe(),
  description: z.string().trim().min(1).max(500),
  counterparty: z.string().trim().min(1).max(200).optional(),
  categoryId: z.string().optional(),
  notes: z.string().trim().min(1).max(2_000).optional(),
});
export type ManualTransactionInput = z.input<typeof manualSchema>;

/**
 * A manual row gets a random dedupe hash: it must never collide with, or hide, a row a later
 * import brings for the same payment (the user can delete the manual one).
 */
function manualDedupeHash(): string {
  return createHash('sha256').update(`manual\u001f${randomUUID()}`).digest('hex');
}

export async function createManualTransaction(
  ctx: ServiceCtx,
  rawInput: ManualTransactionInput,
  opts: WriteOpts<TransactionRow> = {},
): Promise<TransactionRow> {
  assertCanWrite(ctx);
  const input = parseInput(manualSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    assertUuid(input.accountId, 'Account');
    const [account] = await tx
      .select()
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.id, input.accountId),
          eq(financialAccount.householdId, ctx.householdId),
        ),
      );
    if (!account) throw new NotFoundError('Account');
    if (account.archivedAt) throw new ValidationError('Account is archived');
    if (input.categoryId) {
      await requireUsableCategory(tx, ctx, input.categoryId);
      if (input.categoryId === (await findTransferCategory(tx, ctx.householdId))) {
        throw new ValidationError('Use markTransfer to link a transfer; it needs both legs');
      }
    }

    const [row] = await tx
      .insert(transaction)
      .values({
        householdId: ctx.householdId,
        accountId: account.id,
        dedupeHash: manualDedupeHash(),
        bookingDate: input.bookingDate,
        valueDate: input.valueDate ?? null,
        amount: input.amount,
        currency: account.currency,
        status: 'booked',
        rawDescription: input.description,
        counterparty: input.counterparty ?? null,
        notes: input.notes ?? null,
        source: 'manual',
        ...(input.categoryId
          ? { categoryId: input.categoryId, categorisedBy: 'user' as const, needsReview: false }
          : {}),
      })
      .returning();
    if (!input.categoryId) await categorizeInTx(tx, ctx.householdId, [row!.id]);
    const created = input.categoryId ? row! : await requireTransaction(tx, ctx, row!.id);
    await opts.onCommit?.(tx, created);
    return created;
  });
}

const updateSchema = z.strictObject({
  categoryId: z.string().nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  applyToMerchant: z.boolean().optional(),
});
export type UpdateTransactionPatch = z.input<typeof updateSchema>;

const MAX_ALSO_APPLIED = 5_000;
const CHUNK = 1_000;

const rowSnapshotSchema = z.strictObject({
  id: z.uuid(),
  categoryId: z.uuid().nullable(),
  categorisedBy: z.enum(schema.CATEGORISED_BY).nullable(),
  confidence: z.number().nullable(),
  needsReview: z.boolean(),
  merchantId: z.uuid().nullable(),
  transferGroupId: z.uuid().nullable(),
  userEditedAt: z.string().nullable(),
});

/** Everything `revertCategorisation` needs to put a categorisation back exactly as it was. */
const categorisationSnapshotSchema = z.strictObject({
  row: rowSnapshotSchema,
  /** The merchant memory touched by the change (created, or its default replaced). */
  merchant: z
    .strictObject({ id: z.uuid(), defaultBefore: z.uuid().nullable(), created: z.boolean() })
    .nullable(),
  /** Other rows of the merchant that the change categorised too, as they were before. */
  alsoApplied: z.array(rowSnapshotSchema).max(MAX_ALSO_APPLIED),
  ruleId: z.uuid().nullable(),
  /** The row was a transfer leg and the change dissolved the pair (cannot be reverted). */
  unlinkedTransfer: z.boolean(),
});
type CategorisationSnapshot = z.infer<typeof categorisationSnapshotSchema>;

const snapshotOf = (r: TransactionRow): z.infer<typeof rowSnapshotSchema> => ({
  id: r.id,
  categoryId: r.categoryId,
  categorisedBy: r.categorisedBy,
  confidence: r.confidence,
  needsReview: r.needsReview,
  merchantId: r.merchantId,
  transferGroupId: r.transferGroupId,
  userEditedAt: r.userEditedAt ? r.userEditedAt.toISOString() : null,
});

/**
 * Remembers `categoryId` as the default for this transaction's merchant (creating the merchant on
 * first correction). Rows without a usable key are skipped. Returns the merchant and what its
 * default was before, so the change can be reverted.
 */
async function rememberMerchant(
  tx: Tx,
  row: TransactionRow,
  categoryId: string,
): Promise<{ id: string; defaultBefore: string | null; created: boolean; key: string } | null> {
  const key = merchantKey(row.rawDescription, row.counterparty);
  if (!key) return null;
  const [before] = await tx
    .select({ defaultCategoryId: merchant.defaultCategoryId })
    .from(merchant)
    .where(and(eq(merchant.householdId, row.householdId), eq(merchant.key, key)));
  const displayName = (row.counterparty?.trim() || row.rawDescription.trim()).slice(0, 120);
  const [m] = await tx
    .insert(merchant)
    .values({ householdId: row.householdId, key, displayName, defaultCategoryId: categoryId })
    .onConflictDoUpdate({
      target: [merchant.householdId, merchant.key],
      set: { defaultCategoryId: categoryId },
    })
    .returning({ id: merchant.id });
  return {
    id: m!.id,
    defaultBefore: before?.defaultCategoryId ?? null,
    created: before === undefined,
    key,
  };
}

/**
 * Categorises the household's other uncategorised, to-review or AI-categorised rows of the same
 * merchant (never rows the user or a rule categorised, never transfers). They become memory-categorised, out of review.
 */
async function applyToOtherRows(
  tx: Tx,
  householdId: string,
  current: TransactionRow,
  key: string,
  merchantId: string,
  categoryId: string,
): Promise<TransactionRow[]> {
  // A LIKE on the raw text is only a prefilter (it can miss accented spellings); the exact key
  // comparison below decides.
  // Prefilter on the longest token (3+ chars): spacing, dates and word order around it vary.
  const token = [...key.split(/\s+/)].sort((x, y) => y.length - x.length)[0] ?? key;
  const like = likePattern(token.length >= 3 ? token : key);
  const candidates = await tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, householdId),
        ne(transaction.id, current.id),
        isNull(transaction.transferGroupId),
        or(
          isNull(transaction.categoryId),
          eq(transaction.needsReview, true),
          eq(transaction.categorisedBy, 'ai'),
        ),
        or(isNull(transaction.categorisedBy), ne(transaction.categorisedBy, 'user')),
        or(
          eq(transaction.merchantId, merchantId),
          and(
            isNull(transaction.merchantId),
            or(
              sql`${transaction.rawDescription} ilike ${like} escape '\\'`,
              sql`${transaction.counterparty} ilike ${like} escape '\\'`,
            ),
          ),
        ),
      ),
    )
    .orderBy(desc(transaction.bookingDate), transaction.id)
    .limit(MAX_ALSO_APPLIED);
  const same = candidates.filter((r) => merchantKey(r.rawDescription, r.counterparty) === key);
  for (let i = 0; i < same.length; i += CHUNK) {
    await tx
      .update(transaction)
      .set({
        categoryId,
        categorisedBy: 'memory',
        confidence: 0.9,
        needsReview: false,
        merchantId,
      })
      .where(
        and(
          eq(transaction.householdId, householdId),
          inArray(
            transaction.id,
            same.slice(i, i + CHUNK).map((r) => r.id),
          ),
        ),
      );
  }
  return same;
}

interface ApplyResult {
  row: TransactionRow;
  alsoApplied: number;
  snapshot: CategorisationSnapshot;
}

/** The category part of an edit, inside the caller's transaction (transfers lock already held). */
async function applyCategoryInTx(
  tx: Tx,
  ctx: ServiceCtx,
  current: TransactionRow,
  categoryId: string,
  opts: { applyToMerchant: boolean; createRule: boolean },
): Promise<ApplyResult> {
  await requireUsableCategory(tx, ctx, categoryId);
  const transferCategoryId = await findTransferCategory(tx, ctx.householdId);
  const toTransfer = categoryId === transferCategoryId;
  if (toTransfer && !current.transferGroupId) {
    throw new ValidationError('Use markTransfer to link a transfer; it needs both legs');
  }
  const unlinkedTransfer = Boolean(current.transferGroupId) && !toTransfer;
  // Moving a transfer leg to a normal category means it was not a transfer after all.
  if (current.transferGroupId && !toTransfer) {
    await unlinkGroupInTx(tx, ctx.householdId, current.transferGroupId);
  }
  const set: Partial<typeof transaction.$inferInsert> = {
    categoryId,
    categorisedBy: 'user',
    confidence: null,
    needsReview: false,
    userEditedAt: new Date(),
  };
  let remembered: Awaited<ReturnType<typeof rememberMerchant>> = null;
  // Transfers are not merchants: never remember "this vendor is a transfer".
  if (opts.applyToMerchant && !toTransfer) {
    remembered = await rememberMerchant(tx, current, categoryId);
    set.merchantId = remembered?.id ?? null;
  }
  const [row] = await tx
    .update(transaction)
    .set(set)
    .where(eq(transaction.id, current.id))
    .returning();
  const others = remembered
    ? await applyToOtherRows(
        tx,
        ctx.householdId,
        current,
        remembered.key,
        remembered.id,
        categoryId,
      )
    : [];
  let ruleId: string | null = null;
  if (opts.createRule && !toTransfer) {
    const draft = ruleDraftOf(row!);
    const created = await createRuleInTx(tx, ctx, {
      name: draft.name,
      condition: draft.condition,
      categoryId,
    });
    ruleId = created.id;
  }
  return {
    row: row!,
    alsoApplied: others.length,
    snapshot: {
      row: snapshotOf(current),
      merchant: remembered
        ? {
            id: remembered.id,
            defaultBefore: remembered.defaultBefore,
            created: remembered.created,
          }
        : null,
      alsoApplied: others.map(snapshotOf),
      ruleId,
      unlinkedTransfer,
    },
  };
}

const categoriseSchema = z.strictObject({
  id: z.string(),
  categoryId: z.string(),
  applyToMerchant: z.boolean().optional(),
  createRule: z.boolean().optional(),
});
export type CategoriseInput = z.input<typeof categoriseSchema>;
export type CategoriseResult = {
  transaction: TransactionRow;
  /** Other rows of the same merchant categorised by this change. */
  alsoApplied: number;
  /** Opaque id: pass to `revertCategorisation` to undo exactly this change (15 minutes, once). */
  undoToken: string;
};

/**
 * The user's category choice, in one transaction: the row becomes user-categorised and leaves
 * review; with `applyToMerchant` (default) the merchant remembers it and the household's other
 * uncategorised or to-review rows of that merchant get it too; with `createRule` a matching rule
 * is saved. The result carries the snapshot that undoes all of it.
 */
export async function categoriseTransaction(
  ctx: ServiceCtx,
  rawInput: CategoriseInput,
  opts: WriteOpts<CategoriseResult> = {},
): Promise<CategoriseResult> {
  assertCanWrite(ctx);
  const input = parseInput(categoriseSchema, rawInput);
  assertUuid(input.id, 'Transaction');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockTransfers(tx, ctx.householdId);
    const current = await requireTransaction(tx, ctx, input.id);
    const r = await applyCategoryInTx(tx, ctx, current, input.categoryId, {
      applyToMerchant: input.applyToMerchant ?? true,
      createRule: input.createRule ?? false,
    });
    // Cheap housekeeping: expired tokens are of no use to anyone.
    await tx.delete(undoToken).where(lt(undoToken.expiresAt, sql`now()`));
    const [token] = await tx
      .insert(undoToken)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        kind: 'categorisation',
        payload: r.snapshot,
        expiresAt: new Date(Date.now() + UNDO_TTL_MS),
      })
      .returning({ id: undoToken.id });
    const result = { transaction: r.row, alsoApplied: r.alsoApplied, undoToken: token!.id };
    await opts.onCommit?.(tx, result);
    return result;
  });
}

/**
 * Takes back a category the AI applied: the row returns to review with that category as the AI's
 * suggestion (the attempts are capped, so the AI is not asked again). Only rows still categorised
 * by 'ai' and never edited by a user qualify; anything else is a ConflictError
 * ('ai_categorisation_changed') and nothing changes. Returns the updated row, so the caller can
 * re-apply the old category with `categoriseTransaction` to undo the undo.
 */
export async function undoAiCategorisation(
  ctx: ServiceCtx,
  transactionId: string,
): Promise<TransactionRow> {
  assertCanWrite(ctx);
  assertUuid(transactionId, 'Transaction');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .update(transaction)
      .set({
        categoryId: null,
        categorisedBy: null,
        confidence: null,
        needsReview: true,
        // The AI must not judge the row again, and the "Outros" fallback never applies to it.
        aiAttempts: AI_MAX_ATTEMPTS,
        // The pre-update value of category_id: Postgres evaluates SET expressions on the old row.
        aiSuggestedCategoryId: sql`${transaction.categoryId}`,
      })
      .where(
        and(
          eq(transaction.id, transactionId),
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.categorisedBy, 'ai'),
          isNull(transaction.userEditedAt),
          isNull(transaction.transferGroupId),
          sql`${transaction.categoryId} is not null`,
        ),
      )
      .returning();
    if (row) return row;
    await requireTransaction(tx, ctx, transactionId);
    throw new ConflictError('ai_categorisation_changed', 'This categorisation was already changed');
  });
}

/** Rows whose category the AI applied (and that are still AI-categorised) in the last `days`. */
export async function countAiAppliedSince(ctx: ServiceCtx, days = 30): Promise<number> {
  const window = parseInput(z.number().int().min(1).max(3_650), days);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.categorisedBy, 'ai'),
          gte(transaction.updatedAt, new Date(Date.now() - window * 86_400_000)),
        ),
      );
    return row?.n ?? 0;
  });
}

/**
 * Puts a categorisation back as it was, using the token `categoriseTransaction` returned. The
 * server holds what to restore (the client cannot choose it); the token is the caller's own,
 * unused and unexpired, and is spent in the same transaction. Restores the row's category,
 * provenance, review state and edit time, the other rows the change categorised (rows the user
 * categorised since are left alone), the merchant memory and the rule it created. Every restored
 * category and merchant is re-checked against the household. A change that dissolved a transfer
 * cannot be reverted.
 */
export async function revertCategorisation(
  ctx: ServiceCtx,
  token: string,
): Promise<TransactionRow> {
  assertCanWrite(ctx);
  assertUuid(token, 'Undo token');
  // Expired tokens are removed on their own transaction, so the delete survives a refusal below.
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.delete(undoToken).where(lt(undoToken.expiresAt, sql`now()`)),
  );
  const outcome = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    // Same lock order as categorise: transfers first, then the token row.
    await lockTransfers(tx, ctx.householdId);
    const [stored] = await tx
      .select()
      .from(undoToken)
      .where(
        and(
          eq(undoToken.id, token),
          eq(undoToken.householdId, ctx.householdId),
          gt(undoToken.expiresAt, sql`now()`),
        ),
      )
      .for('update');
    if (!stored || stored.userId !== ctx.userId || stored.kind !== 'categorisation') {
      throw new NotFoundError('Undo token');
    }
    if (stored.usedAt) throw new ValidationError('This undo was already used');
    const snap = parseInput(categorisationSnapshotSchema, stored.payload);
    if (snap.unlinkedTransfer) {
      throw new ValidationError('A change that unlinked a transfer cannot be reverted');
    }
    await tx.update(undoToken).set({ usedAt: new Date() }).where(eq(undoToken.id, stored.id));

    const transferCategoryId = await findTransferCategory(tx, ctx.householdId);
    const all = [snap.row, ...snap.alsoApplied];
    const ownedRows = await tx
      .select({ id: transaction.id, transferGroupId: transaction.transferGroupId })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          inArray(
            transaction.id,
            all.map((r) => r.id),
          ),
        ),
      );
    if (!ownedRows.some((r) => r.id === snap.row.id)) throw new NotFoundError('Transaction');
    const linked = new Map(ownedRows.map((r) => [r.id, r.transferGroupId !== null]));
    // A row that became (or stopped being) a transfer leg since: restoring would break the pair.
    // The token is spent (this commits) and the caller gets a clear refusal.
    const current = new Map(ownedRows.map((r) => [r.id, r.transferGroupId]));
    if (all.some((r) => current.has(r.id) && current.get(r.id) !== r.transferGroupId)) {
      return { conflict: true as const };
    }
    for (const r of all) {
      if (r.categoryId) await requireUsableCategory(tx, ctx, r.categoryId);
      if (r.categoryId && r.categoryId === transferCategoryId && !linked.get(r.id)) {
        throw new ValidationError('The transfer category needs a linked transfer');
      }
      if (r.merchantId) {
        const [m] = await tx
          .select({ id: merchant.id })
          .from(merchant)
          .where(and(eq(merchant.id, r.merchantId), eq(merchant.householdId, ctx.householdId)));
        if (!m) throw new NotFoundError('Merchant');
      }
    }
    if (snap.merchant?.defaultBefore)
      await requireUsableCategory(tx, ctx, snap.merchant.defaultBefore);

    const restore = (r: z.infer<typeof rowSnapshotSchema>, guardUser: boolean) =>
      tx
        .update(transaction)
        .set({
          categoryId: r.categoryId,
          categorisedBy: r.categorisedBy,
          confidence: r.confidence,
          needsReview: r.needsReview,
          merchantId: r.merchantId,
          userEditedAt: r.userEditedAt ? new Date(r.userEditedAt) : null,
        })
        .where(
          and(
            eq(transaction.id, r.id),
            eq(transaction.householdId, ctx.householdId),
            guardUser
              ? or(isNull(transaction.categorisedBy), ne(transaction.categorisedBy, 'user'))
              : undefined,
          ),
        );
    for (const r of snap.alsoApplied) await restore(r, true);
    await restore(snap.row, false);
    if (snap.ruleId) {
      await tx
        .delete(schema.rule)
        .where(and(eq(schema.rule.id, snap.ruleId), eq(schema.rule.householdId, ctx.householdId)));
    }
    if (snap.merchant) {
      const m = snap.merchant;
      if (m.created) {
        await tx
          .delete(merchant)
          .where(
            and(
              eq(merchant.id, m.id),
              eq(merchant.householdId, ctx.householdId),
              sql`not exists (select 1 from "transaction" t where t.merchant_id = ${merchant.id})`,
            ),
          );
      } else {
        await tx
          .update(merchant)
          .set({ defaultCategoryId: m.defaultBefore })
          .where(and(eq(merchant.id, m.id), eq(merchant.householdId, ctx.householdId)));
      }
    }
    return { row: await requireTransaction(tx, ctx, snap.row.id) };
  });
  if ('conflict' in outcome) {
    throw new ValidationError('The transaction changed since (transfer link): it cannot be undone');
  }
  return outcome.row;
}

/**
 * Applies a user edit. A category choice behaves like `categoriseTransaction` (user-categorised,
 * out of review, merchant memory unless `applyToMerchant` is false, other rows of the merchant
 * categorised too). `categoryId: null` returns the row to review (a transfer leg dissolves its
 * pair). Notes alone change neither category nor review state.
 */
export async function updateTransaction(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateTransactionPatch,
): Promise<TransactionRow> {
  assertCanWrite(ctx);
  assertUuid(id, 'Transaction');
  const patch = parseInput(updateSchema, rawPatch);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockTransfers(tx, ctx.householdId);
    const current = await requireTransaction(tx, ctx, id);
    const set: Partial<typeof transaction.$inferInsert> = {};
    if (patch.notes !== undefined) {
      set.notes = patch.notes === null || patch.notes === '' ? null : patch.notes;
      set.userEditedAt = new Date();
    }
    if (typeof patch.categoryId === 'string') {
      if (Object.keys(set).length > 0) {
        await tx.update(transaction).set(set).where(eq(transaction.id, id));
      }
      const r = await applyCategoryInTx(tx, ctx, current, patch.categoryId, {
        applyToMerchant: patch.applyToMerchant ?? true,
        createRule: false,
      });
      return r.row;
    }
    if (patch.categoryId === null) {
      // Back to the review inbox. The merchant memory is only cleared on request.
      if (current.transferGroupId) {
        await unlinkGroupInTx(tx, ctx.householdId, current.transferGroupId);
      }
      set.categoryId = null;
      set.categorisedBy = null;
      set.confidence = null;
      set.needsReview = true;
      // The user sent it back: the AI sweep and the "Outros" fallback must not judge it again.
      set.aiAttempts = AI_MAX_ATTEMPTS;
      set.userEditedAt = new Date();
      if (patch.applyToMerchant === true && current.merchantId) {
        await tx
          .update(merchant)
          .set({ defaultCategoryId: null })
          .where(
            and(eq(merchant.id, current.merchantId), eq(merchant.householdId, ctx.householdId)),
          );
      }
    }
    if (Object.keys(set).length === 0) return current;
    const [row] = await tx.update(transaction).set(set).where(eq(transaction.id, id)).returning();
    return row!;
  });
}

/** Deletes a manually entered row (imported and connector rows are removed by undoing the import). */
export async function deleteManualTransaction(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Transaction');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockTransfers(tx, ctx.householdId);
    const row = await requireTransaction(tx, ctx, id);
    if (row.source !== 'manual') {
      throw new ValidationError('Only manually entered transactions can be deleted');
    }
    if (row.transferGroupId) await unlinkGroupInTx(tx, ctx.householdId, row.transferGroupId);
    await tx.delete(transaction).where(eq(transaction.id, id));
  });
}

// ---------------------------------------------------------------------------------------------
// Transfers

/** Pairs two transactions as the two legs of one transfer between different accounts. */
export async function markTransfer(ctx: ServiceCtx, idA: string, idB: string): Promise<string> {
  assertCanWrite(ctx);
  assertUuid(idA, 'Transaction');
  assertUuid(idB, 'Transaction');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await lockTransfers(tx, ctx.householdId);
    const a = await requireTransaction(tx, ctx, idA);
    const b = await requireTransaction(tx, ctx, idB);
    if (a.id === b.id) throw new ValidationError('A transfer needs two different transactions');
    if (a.accountId === b.accountId) {
      throw new ValidationError('The two legs of a transfer must be on different accounts');
    }
    if (Math.sign(a.amount) === Math.sign(b.amount) || a.amount === 0 || b.amount === 0) {
      throw new ValidationError('One leg must be an outflow and the other an inflow');
    }
    if (a.transferGroupId || b.transferGroupId) {
      throw new ValidationError('A transaction is already part of a transfer: unlink it first');
    }
    const categoryId = await ensureTransferCategory(tx, ctx.householdId);
    try {
      return await linkTransferLegs(tx, ctx.householdId, [a.id, b.id], categoryId, 'user');
    } catch (error) {
      if (error instanceof TransferLinkConflictError) {
        throw new ValidationError('A transaction is already part of a transfer: unlink it first');
      }
      throw error;
    }
  });
}

export async function unlinkTransfer(ctx: ServiceCtx, transferGroupId: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(transferGroupId, 'Transfer');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const count = await unlinkGroupInTx(tx, ctx.householdId, transferGroupId);
    if (count === 0) throw new NotFoundError('Transfer');
  });
}

/**
 * Rows eligible for automatic transfer pairing: booked, unlinked, not transfer-locked (a
 * transfer the user marked or unlinked must not be re-paired behind their back; other edits such
 * as notes do not matter here) and uncategorised, or categorised only automatically by memory or
 * the AI (including its "Outros" fallback): a leg is categorised before its counter-leg arrives.
 * Rows a user or a rule categorised never qualify.
 */
export function transferCandidateFilter(householdId: string, since: string): SQL {
  return and(
    eq(transaction.householdId, householdId),
    eq(transaction.status, 'booked'),
    isNull(transaction.transferGroupId),
    // Anything categorised automatically (rule, memory, AI) may still turn out to be a transfer
    // leg; a category the user chose never is overridden.
    or(
      isNull(transaction.categoryId),
      inArray(transaction.categorisedBy, ['rule', 'memory', 'ai']),
    ),
    eq(transaction.transferLocked, false),
    gte(transaction.bookingDate, since),
  )!;
}
