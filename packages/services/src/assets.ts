import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AI_VALUATION_KINDS, assetDetailsSchemaFor } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { isUniqueViolation, requireAccount } from './budgets.js';
import {
  assertCanWrite,
  assertOwner,
  assertUuid,
  calendarDate,
  currencyCode,
  MAX_AMOUNT_MINOR,
  NotFoundError,
  parseInput,
  ValidationError,
  type WriteOpts,
  type ServiceCtx,
} from './context.js';
import { settleLiabilityInTx } from './liabilities.js';
import {
  householdClock,
  refreshAllStoredSnapshotsInTx,
  refreshStoredSnapshotsInTx,
} from './net-worth.js';

const { asset, assetValuation, financialAccount, householdSettings, liability, transaction } =
  schema;

export type Asset = typeof asset.$inferSelect;
export type AssetValuation = typeof assetValuation.$inferSelect;

const assetFields = {
  kind: z.enum(schema.ASSET_KINDS),
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().min(1).max(2_000).nullable(),
  accountId: z.string().nullable(),
  depreciationBpsPerYear: z.number().int().min(0).max(10_000).nullable(),
  position: z.number().int().min(0).max(32_767),
  details: z.record(z.string(), z.unknown()).nullable(),
  aiValuation: z.boolean(),
};

const createSchema = z.strictObject({
  kind: assetFields.kind,
  name: assetFields.name,
  notes: assetFields.notes.optional(),
  accountId: assetFields.accountId.optional(),
  currency: currencyCode.optional(),
  depreciationBpsPerYear: assetFields.depreciationBpsPerYear.optional(),
  position: assetFields.position.optional(),
  details: assetFields.details.optional(),
  aiValuation: assetFields.aiValuation.optional(),
});

// The currency is fixed: valuations are stored in it without conversion.
const patchSchema = z.strictObject({
  kind: assetFields.kind.optional(),
  name: assetFields.name.optional(),
  notes: assetFields.notes.optional(),
  accountId: assetFields.accountId.optional(),
  depreciationBpsPerYear: assetFields.depreciationBpsPerYear.optional(),
  position: assetFields.position.optional(),
  details: assetFields.details.optional(),
  aiValuation: assetFields.aiValuation.optional(),
});

const valuationFields = {
  asOf: calendarDate,
  value: z.number().int().min(0).max(MAX_AMOUNT_MINOR),
  note: z.string().trim().min(1).max(500).nullable().optional(),
};
// Users record manual values; import, connector and depreciation rows come from their own paths.
const valuationSchema = z.strictObject({
  ...valuationFields,
  method: z.literal('manual').optional(),
});
const storedValuationSchema = z.strictObject({
  ...valuationFields,
  method: z.enum(schema.VALUATION_METHODS),
});

export type CreateAssetInput = z.input<typeof createSchema>;
export type UpdateAssetPatch = z.input<typeof patchSchema>;
export type AssetValuationInput = z.input<typeof valuationSchema>;

export async function requireAsset(tx: Tx, householdId: string, id: string): Promise<Asset> {
  assertUuid(id, 'Asset');
  const [row] = await tx
    .select()
    .from(asset)
    .where(and(eq(asset.id, id), eq(asset.householdId, householdId)));
  if (!row) throw new NotFoundError('Asset');
  return row;
}

const isAiKind = (kind: string) => (AI_VALUATION_KINDS as readonly string[]).includes(kind);

const notEligible = (message: string) =>
  new ValidationError(message, [{ path: ['aiValuation'], message }], 'ai_not_eligible');

const depreciationConflict = () =>
  new ValidationError(
    'A depreciation rate cannot be set while AI values the asset',
    [{ path: ['depreciationBpsPerYear'], message: 'conflicts with AI valuation' }],
    'ai_depreciation_conflict',
  );

/**
 * Details for `kind` as they are stored: empty-string and null values are dropped (a cleared form
 * field), an object left empty becomes null, and the rest must match the kind's schema.
 * Investment and cash have no details.
 */
function normaliseDetails(
  kind: string,
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const kept = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== '' && v !== null),
  );
  if (Object.keys(kept).length === 0) return null;
  const detailsSchema = assetDetailsSchemaFor(kind);
  if (!detailsSchema) {
    throw new ValidationError(`Assets of kind ${kind} have no details`, [
      { path: ['details'], message: 'not allowed for this kind' },
    ]);
  }
  return parseInput(detailsSchema, kept) as Record<string, unknown>;
}

/**
 * An account is counted for at most one live asset or liability: a second record linked to it
 * would only ever show without a value. `self` is the record being written (it may keep its link).
 * Archived or disposed assets and archived or settled liabilities hold no claim. Refused with `account_already_linked` naming the record.
 */
export async function assertAccountUnclaimed(
  tx: Tx,
  householdId: string,
  accountId: string,
  self?: { side: 'asset' | 'liability'; id: string },
): Promise<void> {
  const notSelf = (side: 'asset' | 'liability', id: typeof asset.id | typeof liability.id) =>
    self?.side === side ? ne(id, self.id) : undefined;
  const [claim] = [
    ...(await tx
      .select({ name: asset.name })
      .from(asset)
      .where(
        and(
          eq(asset.householdId, householdId),
          eq(asset.accountId, accountId),
          eq(asset.archived, false),
          isNull(asset.disposedOn),
          notSelf('asset', asset.id),
        ),
      )
      .limit(1)),
    ...(await tx
      .select({ name: liability.name })
      .from(liability)
      .where(
        and(
          eq(liability.householdId, householdId),
          eq(liability.accountId, accountId),
          eq(liability.archived, false),
          isNull(liability.settledOn),
          notSelf('liability', liability.id),
        ),
      )
      .limit(1)),
  ];
  if (claim) {
    throw new ValidationError(
      'Another record already counts this account',
      [{ path: ['accountId'], message: 'already linked' }],
      'account_already_linked',
      { name: claim.name },
    );
  }
}

/** The accounts live assets and liabilities are linked to, with the id of that record. */
export async function claimedAccounts(tx: Tx, householdId: string): Promise<Map<string, string>> {
  const rows = [
    ...(await tx
      .select({ id: asset.id, accountId: asset.accountId })
      .from(asset)
      .where(
        and(
          eq(asset.householdId, householdId),
          eq(asset.archived, false),
          isNull(asset.disposedOn),
        ),
      )),
    ...(await tx
      .select({ id: liability.id, accountId: liability.accountId })
      .from(liability)
      .where(
        and(
          eq(liability.householdId, householdId),
          eq(liability.archived, false),
          isNull(liability.settledOn),
        ),
      )),
  ];
  const claims = new Map<string, string>();
  for (const r of rows) if (r.accountId && !claims.has(r.accountId)) claims.set(r.accountId, r.id);
  return claims;
}

/** Assets in list order (read: any role). Archived and disposed ones only on request. */
export async function listAssets(
  ctx: ServiceCtx,
  opts: { includeArchived?: boolean; includeDisposed?: boolean } = {},
): Promise<Asset[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(asset)
      .where(
        and(
          eq(asset.householdId, ctx.householdId),
          opts.includeArchived ? undefined : eq(asset.archived, false),
          opts.includeDisposed ? undefined : isNull(asset.disposedOn),
        ),
      )
      .orderBy(asc(asset.position), asc(asset.name), asc(asset.id)),
  );
}

/** Creates an asset inside a transaction; the currency defaults to the household's. No role check. */
/** A credit card is never an asset, so no asset is valued through one. */
async function assertNotCard(tx: Tx, householdId: string, accountId: string): Promise<void> {
  const [row] = await tx
    .select({ type: schema.financialAccount.type })
    .from(schema.financialAccount)
    .where(
      and(
        eq(schema.financialAccount.id, accountId),
        eq(schema.financialAccount.householdId, householdId),
      ),
    );
  if (row?.type === 'card') {
    throw new ValidationError('A credit card cannot be linked to an asset', [
      { path: ['accountId'], message: 'a credit card cannot be linked to an asset' },
    ]);
  }
}

export async function createAssetInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateAssetInput,
): Promise<Asset> {
  const {
    details: rawDetails,
    aiValuation: wantsAi,
    ...input
  } = parseInput(createSchema, rawInput);
  if (input.accountId) {
    await requireAccount(tx, householdId, input.accountId);
    await assertNotCard(tx, householdId, input.accountId);
    await assertAccountUnclaimed(tx, householdId, input.accountId);
  }
  const details = normaliseDetails(input.kind, rawDetails ?? null);
  const ai: Partial<typeof asset.$inferInsert> = {};
  if (wantsAi) {
    if (!isAiKind(input.kind) || input.accountId) {
      throw notEligible(
        'Only assets of an AI-valued kind without a linked account can be valued by AI',
      );
    }
    if (input.depreciationBpsPerYear != null) throw depreciationConflict();
    Object.assign(ai, { aiValuation: true, aiRequestedAt: new Date() });
  }
  let currency = input.currency;
  if (!currency) {
    const [settings] = await tx
      .select({ currency: householdSettings.currency })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    currency = settings?.currency ?? 'EUR';
  }
  const [row] = await tx
    .insert(asset)
    .values({ ...input, details, ...ai, currency, householdId })
    .returning();
  return row!;
}

/** Creates an asset; the currency defaults to the household's. */
export async function createAsset(ctx: ServiceCtx, rawInput: CreateAssetInput): Promise<Asset> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createAssetInTx(tx, ctx.householdId, rawInput),
  );
}

/** Updates an asset inside a transaction. No role check. */
export async function updateAssetInTx(
  tx: Tx,
  householdId: string,
  id: string,
  rawPatch: UpdateAssetPatch,
): Promise<Asset> {
  assertUuid(id, 'Asset');
  const { details: rawDetails, aiValuation: wantsAi, ...patch } = parseInput(patchSchema, rawPatch);
  if (patch.accountId) {
    await requireAccount(tx, householdId, patch.accountId);
    await assertNotCard(tx, householdId, patch.accountId);
    await assertAccountUnclaimed(tx, householdId, patch.accountId, { side: 'asset', id });
  }
  const set: Partial<typeof asset.$inferInsert> = { ...patch };
  const touchesAi =
    rawDetails !== undefined ||
    wantsAi !== undefined ||
    patch.kind !== undefined ||
    patch.accountId !== undefined ||
    patch.depreciationBpsPerYear !== undefined;
  if (touchesAi) {
    const cur = await requireAsset(tx, householdId, id);
    const kind = patch.kind ?? cur.kind;
    const accountId = patch.accountId !== undefined ? patch.accountId : cur.accountId;
    // Stored details are re-checked against a new kind; a kind without details drops them.
    let details = cur.details;
    if (rawDetails !== undefined || patch.kind !== undefined) {
      details = assetDetailsSchemaFor(kind)
        ? normaliseDetails(kind, rawDetails !== undefined ? rawDetails : cur.details)
        : normaliseDetails(kind, rawDetails ?? null);
      set.details = details;
    }
    const eligible = isAiKind(kind) && !accountId;
    if (wantsAi && !eligible) {
      throw notEligible(
        'Only assets of an AI-valued kind without a linked account can be valued by AI',
      );
    }
    // A kind or a link that rules AI out switches it off rather than failing the patch.
    const ai = (wantsAi ?? cur.aiValuation) && eligible;
    if (ai && patch.depreciationBpsPerYear != null) throw depreciationConflict();
    if (ai !== cur.aiValuation) set.aiValuation = ai;
    if (ai && !cur.aiValuation) {
      set.depreciationBpsPerYear = null;
      set.aiRequestedAt = new Date();
      set.aiLastError = null;
    } else if (ai && rawDetails !== undefined && !isDeepStrictEqual(details, cur.details)) {
      set.aiRequestedAt = new Date();
      set.aiLastError = null;
    }
  }
  if (Object.keys(set).length === 0) return requireAsset(tx, householdId, id);
  const [row] = await tx
    .update(asset)
    .set(set)
    .where(and(eq(asset.id, id), eq(asset.householdId, householdId)))
    .returning();
  if (!row) throw new NotFoundError('Asset');
  // A link or a depreciation rate changes what the asset was worth in past months too.
  if (set.accountId !== undefined || set.depreciationBpsPerYear !== undefined) {
    await refreshAllStoredSnapshotsInTx(tx, householdId);
  }
  return row;
}

export async function updateAsset(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateAssetPatch,
): Promise<Asset> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    updateAssetInTx(tx, ctx.householdId, id, rawPatch),
  );
}

/** Asks for a fresh AI estimate: the job picks the asset up on its next run. Writers only. */
export async function requestAssetEstimate(ctx: ServiceCtx, id: string): Promise<Asset> {
  assertCanWrite(ctx);
  assertUuid(id, 'Asset');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const cur = await requireAsset(tx, ctx.householdId, id);
    if (!cur.aiValuation) throw notEligible('AI valuation is not turned on for this asset');
    const [row] = await tx
      .update(asset)
      .set({ aiRequestedAt: new Date(), aiLastError: null })
      .where(and(eq(asset.id, id), eq(asset.householdId, ctx.householdId)))
      .returning();
    return row!;
  });
}

/**
 * Writes spreadsheet-imported valuations (`method = 'import'`) inside a transaction. A day that
 * already holds an import-sourced value takes the new one; a day holding a manual, connector or
 * depreciation value is left exactly as it is. No role check.
 */
export async function replaceImportedValuationsInTx(
  tx: Tx,
  householdId: string,
  assetId: string,
  values: Array<{ asOf: string; value: number }>,
): Promise<void> {
  if (values.length === 0) return;
  const rows = values.map((v) => {
    const input = parseInput(storedValuationSchema, { ...v, method: 'import' });
    return {
      householdId,
      assetId,
      asOf: input.asOf,
      value: input.value,
      method: 'import' as const,
    };
  });
  await tx
    .insert(assetValuation)
    .values(rows)
    .onConflictDoUpdate({
      target: [assetValuation.assetId, assetValuation.asOf],
      set: { value: sql`excluded.value` },
      setWhere: eq(assetValuation.method, 'import'),
    });
}

/** Soft-removes an asset (its valuations stay). Idempotent. */
export async function archiveAsset(ctx: ServiceCtx, id: string): Promise<Asset> {
  assertCanWrite(ctx);
  assertUuid(id, 'Asset');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .update(asset)
      .set({ archived: true })
      .where(and(eq(asset.id, id), eq(asset.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Asset');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    return row;
  });
}

/** Valuations of an asset, newest first (read: any role). */
export async function listAssetValuations(
  ctx: ServiceCtx,
  assetId: string,
): Promise<AssetValuation[]> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireAsset(tx, ctx.householdId, assetId);
    return tx
      .select()
      .from(assetValuation)
      .where(
        and(eq(assetValuation.assetId, assetId), eq(assetValuation.householdId, ctx.householdId)),
      )
      .orderBy(desc(assetValuation.asOf));
  });
}

/**
 * Records a manual value on a day; a second value for the same day replaces the first. Stored
 * net worth months from that day's month on are recomputed.
 */
export async function addAssetValuation(
  ctx: ServiceCtx,
  assetId: string,
  rawInput: AssetValuationInput,
  opts: WriteOpts<AssetValuation> = {},
): Promise<AssetValuation> {
  assertCanWrite(ctx);
  assertUuid(assetId, 'Asset');
  const input = parseInput(valuationSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const cur = await requireAsset(tx, ctx.householdId, assetId);
    if (cur.disposedOn !== null && input.asOf >= cur.disposedOn) {
      throw new ValidationError(
        'The asset was sold or written off on or before this date',
        [{ path: ['asOf'], message: 'on or after the disposal' }],
        'asset_disposed',
      );
    }
    const values = {
      value: input.value,
      method: 'manual' as const,
      note: input.note ?? null,
      // replacing an ai value of the same day: its range and sources no longer apply
      estimate: null,
    };
    const [row] = await tx
      .insert(assetValuation)
      .values({ householdId: ctx.householdId, assetId, asOf: input.asOf, ...values })
      .onConflictDoUpdate({
        target: [assetValuation.assetId, assetValuation.asOf],
        set: values,
      })
      .returning();
    await refreshStoredSnapshotsInTx(tx, ctx.householdId, input.asOf);
    await opts.onCommit?.(tx, row!);
    return row!;
  });
}

/** Deletes a valuation; stored net worth months from its month on are recomputed. */
export async function deleteAssetValuation(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Valuation');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .delete(assetValuation)
      .where(and(eq(assetValuation.id, id), eq(assetValuation.householdId, ctx.householdId)))
      .returning({ asOf: assetValuation.asOf });
    if (!row) throw new NotFoundError('Valuation');
    await refreshStoredSnapshotsInTx(tx, ctx.householdId, row.asOf);
  });
}

const disposeSchema = z.strictObject({
  kind: z.enum(schema.DISPOSAL_KINDS),
  date: calendarDate.optional(),
  amount: z.number().int().min(0).max(MAX_AMOUNT_MINOR).optional(),
  transactionId: z.string().optional(),
  settle: z.array(z.strictObject({ liabilityId: z.string(), date: calendarDate })).optional(),
});

export type DisposeAssetInput = z.input<typeof disposeSchema>;

const fieldError = (path: string, message: string) =>
  new ValidationError(message, [{ path: [path], message }]);

const disposalError = (message: string, path: string, code: 'sale_transaction_invalid') =>
  new ValidationError(message, [{ path: [path], message }], code);

/**
 * Sells or writes off an asset: it stops counting from the day. A sale is either typed (date and
 * amount) or taken from an incoming booked transaction (its booking date and amount). Linked
 * liabilities listed in `settle` are settled in the same transaction; any failure undoes all of it.
 */
export async function disposeAsset(
  ctx: ServiceCtx,
  id: string,
  rawInput: DisposeAssetInput,
  opts: WriteOpts<Asset> = {},
): Promise<Asset> {
  assertCanWrite(ctx);
  assertUuid(id, 'Asset');
  const input = parseInput(disposeSchema, rawInput);
  if (input.kind === 'written_off') {
    if (input.amount !== undefined) throw fieldError('amount', 'not allowed for a write-off');
    if (input.transactionId !== undefined) {
      throw fieldError('transactionId', 'not allowed for a write-off');
    }
    if (input.date === undefined) throw fieldError('date', 'required');
  } else if (input.transactionId !== undefined) {
    if (input.date !== undefined) throw fieldError('date', 'comes from the transaction');
    if (input.amount !== undefined) throw fieldError('amount', 'comes from the transaction');
  } else if (input.date === undefined || input.amount === undefined) {
    throw new ValidationError(
      'A sale needs a transaction, or a date and an amount',
      [{ path: ['amount'], message: 'required' }],
      'sale_needs_amount',
    );
  }
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const cur = await requireAsset(tx, ctx.householdId, id);
    if (cur.archived) {
      throw new ValidationError('The asset is archived', [], 'asset_archived');
    }
    if (cur.disposedOn !== null) throw alreadyDisposed();
    let date = input.date;
    let saleAmount = input.amount ?? null;
    if (input.transactionId !== undefined) {
      const booked = await requireSaleTransaction(tx, ctx.householdId, cur, input.transactionId);
      date = booked.bookingDate;
      saleAmount = booked.amount;
    }
    const { today } = await householdClock(tx, ctx.householdId, new Date());
    if (date! > today) {
      throw new ValidationError(
        'An asset cannot be disposed of in the future',
        [{ path: ['date'], message: 'in the future' }],
        'date_in_future',
      );
    }
    let row: Asset | undefined;
    try {
      [row] = await tx
        .update(asset)
        .set({
          disposedOn: date!,
          disposalKind: input.kind,
          saleAmount: input.kind === 'sold' ? saleAmount : null,
          saleTransactionId: input.kind === 'sold' ? (input.transactionId ?? null) : null,
        })
        .where(
          and(eq(asset.id, id), eq(asset.householdId, ctx.householdId), isNull(asset.disposedOn)),
        )
        .returning();
    } catch (err) {
      // Two sales raced for the same transaction: the unique index lets only one win.
      if (isUniqueViolation(err, 'asset_sale_transaction_unique')) throw saleTransactionTaken();
      throw err;
    }
    if (!row) throw alreadyDisposed();
    for (const s of input.settle ?? []) {
      assertUuid(s.liabilityId, 'Liability');
      const [linked] = await tx
        .select({ assetId: liability.assetId })
        .from(liability)
        .where(and(eq(liability.id, s.liabilityId), eq(liability.householdId, ctx.householdId)));
      if (!linked) throw new NotFoundError('Liability');
      if (linked.assetId !== id) {
        throw new ValidationError(
          'The liability is not linked to this asset',
          [{ path: ['settle'], message: 'not linked' }],
          'liability_not_linked',
        );
      }
      await settleLiabilityInTx(tx, ctx.householdId, s.liabilityId, s.date, { refresh: false });
    }
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await opts.onCommit?.(tx, row);
    return row;
  });
}

const saleTransactionTaken = () =>
  new ValidationError(
    'Another asset was sold with this transaction',
    [{ path: ['transactionId'], message: 'already used' }],
    'sale_transaction_taken',
  );

const alreadyDisposed = () =>
  new ValidationError('The asset is already sold or written off', [], 'asset_already_disposed');

/** The incoming booked transaction a sale is recorded with, or the reason it cannot be. */
async function requireSaleTransaction(
  tx: Tx,
  householdId: string,
  target: Asset,
  transactionId: string,
) {
  if (!z.uuid().safeParse(transactionId).success) {
    throw disposalError('Not a transaction', 'transactionId', 'sale_transaction_invalid');
  }
  const [row] = await tx
    .select({
      bookingDate: transaction.bookingDate,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
      transferGroupId: transaction.transferGroupId,
      archivedAt: financialAccount.archivedAt,
    })
    .from(transaction)
    .innerJoin(
      financialAccount,
      and(
        eq(financialAccount.id, transaction.accountId),
        eq(financialAccount.householdId, transaction.householdId),
      ),
    )
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
  if (
    !row ||
    row.status !== 'booked' ||
    row.amount <= 0 ||
    row.transferGroupId !== null ||
    row.archivedAt !== null ||
    row.currency !== target.currency
  ) {
    throw disposalError(
      'The transaction cannot record this sale',
      'transactionId',
      'sale_transaction_invalid',
    );
  }
  const [taken] = await tx
    .select({ id: asset.id })
    .from(asset)
    .where(and(eq(asset.householdId, householdId), eq(asset.saleTransactionId, transactionId)));
  if (taken) throw saleTransactionTaken();
  return row;
}

/** Reopens a sold or written-off asset: the four disposal columns are cleared. Settled liabilities stay settled. */
export async function undoAssetDisposal(
  ctx: ServiceCtx,
  id: string,
  opts: WriteOpts<Asset> = {},
): Promise<Asset> {
  assertCanWrite(ctx);
  assertUuid(id, 'Asset');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const cur = await requireAsset(tx, ctx.householdId, id);
    if (cur.disposedOn === null) throw notDisposed();
    // Another record may have taken the account while this one was disposed of.
    if (cur.accountId && !cur.archived) {
      await assertAccountUnclaimed(tx, ctx.householdId, cur.accountId, { side: 'asset', id });
    }
    const [row] = await tx
      .update(asset)
      .set({ disposedOn: null, disposalKind: null, saleAmount: null, saleTransactionId: null })
      .where(
        and(eq(asset.id, id), eq(asset.householdId, ctx.householdId), isNotNull(asset.disposedOn)),
      )
      .returning();
    if (!row) throw notDisposed();
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await opts.onCommit?.(tx, row);
    return row;
  });
}

const notDisposed = () =>
  new ValidationError('The asset is not sold or written off', [], 'asset_not_disposed');

/** Deletes an asset with its valuations; liabilities linked to it keep existing, unlinked (owner only). */
export async function deleteAsset(
  ctx: ServiceCtx,
  id: string,
  opts: WriteOpts<Asset> = {},
): Promise<void> {
  assertOwner(ctx);
  assertUuid(id, 'Asset');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .delete(asset)
      .where(and(eq(asset.id, id), eq(asset.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Asset');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await opts.onCommit?.(tx, row);
  });
}

export type SaleCandidate = {
  id: string;
  bookingDate: string;
  amount: number;
  currency: string;
  accountId: string;
  accountName: string;
  description: string;
};

const SALE_CANDIDATES_DEFAULT = 30;
const SALE_CANDIDATES_MAX = 100;
const SALE_SEARCH_MAX_LENGTH = 200;
const searchSchema = z.string().max(SALE_SEARCH_MAX_LENGTH).optional();

/**
 * Incoming booked transactions that could record the sale of an asset, newest first (read: any
 * role): same currency, no transfers, active accounts, not already another asset's sale.
 * `search` matches the description or counterparty, ignoring case.
 */
export async function listSaleCandidates(
  ctx: ServiceCtx,
  assetId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<SaleCandidate[]> {
  const wanted = Number.isFinite(opts.limit) ? Math.trunc(opts.limit!) : SALE_CANDIDATES_DEFAULT;
  const limit = Math.min(Math.max(wanted, 1), SALE_CANDIDATES_MAX);
  const term = parseInput(searchSchema, opts.search)?.trim();
  const pattern = term ? `%${term.replace(/[\\%_]/g, '\\$&')}%` : undefined;
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const target = await requireAsset(tx, ctx.householdId, assetId);
    const rows = await tx
      .select({
        id: transaction.id,
        bookingDate: transaction.bookingDate,
        amount: transaction.amount,
        currency: transaction.currency,
        accountId: transaction.accountId,
        accountName: financialAccount.name,
        rawDescription: transaction.rawDescription,
        counterparty: transaction.counterparty,
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
          eq(transaction.status, 'booked'),
          gt(transaction.amount, 0),
          isNull(transaction.transferGroupId),
          isNull(financialAccount.archivedAt),
          eq(transaction.currency, target.currency),
          sql`not exists (
            select 1 from ${asset} other
            where other.sale_transaction_id = ${transaction.id} and other.id <> ${assetId}
          )`,
          pattern
            ? or(
                ilike(transaction.rawDescription, pattern),
                ilike(transaction.counterparty, pattern),
              )
            : undefined,
        ),
      )
      .orderBy(desc(transaction.bookingDate), desc(transaction.id))
      .limit(limit);
    return rows.map(({ rawDescription, counterparty, ...r }) => ({
      ...r,
      description: counterparty ?? rawDescription,
    }));
  });
}
