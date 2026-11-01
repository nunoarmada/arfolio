import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  amortisationSchedule,
  annuityPayment,
  type AmortisationParams,
  type AmortisationRow,
} from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { assertAccountUnclaimed, requireAsset } from './assets.js';
import { requireAccount } from './budgets.js';
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
  type ServiceCtx,
  type WriteOpts,
} from './context.js';
import {
  householdClock,
  refreshAllStoredSnapshotsInTx,
  refreshStoredSnapshotsInTx,
} from './net-worth.js';

const { liability, liabilityBalance, householdSettings } = schema;

export type Liability = typeof liability.$inferSelect;
export type LiabilityBalance = typeof liabilityBalance.$inferSelect;

const amount = z.number().int().min(0).max(MAX_AMOUNT_MINOR);
const rateBps = z.number().int().min(0).max(100_000);
const termMonths = z.number().int().min(1).max(600);

const liabilityFields = {
  kind: z.enum(schema.LIABILITY_KINDS),
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().min(1).max(2_000).nullable(),
  accountId: z.string().nullable(),
  assetId: z.string().nullable(),
  principal: amount.nullable(),
  annualRateBps: rateBps.nullable(),
  termMonths: termMonths.nullable(),
  startDate: calendarDate.nullable(),
  position: z.number().int().min(0).max(32_767),
};

const createSchema = z.strictObject({
  kind: liabilityFields.kind,
  name: liabilityFields.name,
  notes: liabilityFields.notes.optional(),
  accountId: liabilityFields.accountId.optional(),
  assetId: liabilityFields.assetId.optional(),
  currency: currencyCode.optional(),
  principal: liabilityFields.principal.optional(),
  annualRateBps: liabilityFields.annualRateBps.optional(),
  termMonths: liabilityFields.termMonths.optional(),
  startDate: liabilityFields.startDate.optional(),
  position: liabilityFields.position.optional(),
});

// The currency is fixed: balances are stored in it without conversion.
const patchSchema = z.strictObject({
  kind: liabilityFields.kind.optional(),
  name: liabilityFields.name.optional(),
  notes: liabilityFields.notes.optional(),
  accountId: liabilityFields.accountId.optional(),
  assetId: liabilityFields.assetId.optional(),
  principal: liabilityFields.principal.optional(),
  annualRateBps: liabilityFields.annualRateBps.optional(),
  termMonths: liabilityFields.termMonths.optional(),
  startDate: liabilityFields.startDate.optional(),
  position: liabilityFields.position.optional(),
});

const scheduleSchema = z.strictObject({
  principal: amount,
  annualRateBps: rateBps,
  termMonths,
  startDate: calendarDate,
});

const balanceFields = {
  asOf: calendarDate,
  balance: amount,
  note: z.string().trim().min(1).max(500).nullable().optional(),
};
// Users record manual balances; import, connector and schedule rows come from their own paths.
const balanceSchema = z.strictObject({
  ...balanceFields,
  source: z.literal('manual').optional(),
});
const storedBalanceSchema = z.strictObject({
  ...balanceFields,
  source: z.enum(schema.LIABILITY_BALANCE_SOURCES),
});

export type CreateLiabilityInput = z.input<typeof createSchema>;
export type UpdateLiabilityPatch = z.input<typeof patchSchema>;
export type LiabilityScheduleInput = z.input<typeof scheduleSchema>;
export type LiabilityBalanceInput = z.input<typeof balanceSchema>;
export type LiabilitySchedule = {
  params: AmortisationParams;
  /** Level monthly instalment (the last one settles the remainder). */
  payment: number;
  rows: AmortisationRow[];
};

async function requireLiability(tx: Tx, householdId: string, id: string): Promise<Liability> {
  assertUuid(id, 'Liability');
  const [row] = await tx
    .select()
    .from(liability)
    .where(and(eq(liability.id, id), eq(liability.householdId, householdId)));
  if (!row) throw new NotFoundError('Liability');
  return row;
}

async function requireLinks(
  tx: Tx,
  householdId: string,
  links: { accountId?: string | null | undefined; assetId?: string | null | undefined },
  selfId?: string,
  /** The asset the liability already points at: it may keep that link even when no longer live. */
  currentAssetId?: string | null,
): Promise<void> {
  if (links.accountId) {
    await requireAccount(tx, householdId, links.accountId);
    await assertAccountUnclaimed(
      tx,
      householdId,
      links.accountId,
      selfId ? { side: 'liability', id: selfId } : undefined,
    );
  }
  if (links.assetId) {
    const target = await requireAsset(tx, householdId, links.assetId);
    if ((target.archived || target.disposedOn !== null) && target.id !== currentAssetId) {
      throw new ValidationError(
        'The asset is archived or already disposed of',
        [{ path: ['assetId'], message: 'not live' }],
        'asset_not_live',
      );
    }
  }
}

/** A card has no financed asset: a card ending up linked to one is refused. */
function assertLinkAllowed(kind: string, assetId: string | null | undefined): void {
  if (kind === 'card' && assetId) {
    throw new ValidationError(
      'A card cannot be linked to an asset',
      [{ path: ['assetId'], message: 'not allowed for cards' }],
      'card_cannot_link_asset',
    );
  }
}

/** The amortisation inputs of a liability, or null while any of the four is missing. */
export function scheduleParamsOf(
  row: Pick<Liability, 'principal' | 'annualRateBps' | 'termMonths' | 'startDate'>,
): AmortisationParams | null {
  if (
    row.principal === null ||
    row.annualRateBps === null ||
    row.termMonths === null ||
    row.startDate === null
  ) {
    return null;
  }
  return {
    principal: row.principal,
    annualRateBps: row.annualRateBps,
    termMonths: row.termMonths,
    startDate: row.startDate,
  };
}

/** Liabilities in list order (read: any role). Archived and settled ones only on request. */
export async function listLiabilities(
  ctx: ServiceCtx,
  opts: { includeArchived?: boolean; includeSettled?: boolean } = {},
): Promise<Liability[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(liability)
      .where(
        and(
          eq(liability.householdId, ctx.householdId),
          opts.includeArchived ? undefined : eq(liability.archived, false),
          opts.includeSettled ? undefined : isNull(liability.settledOn),
        ),
      )
      .orderBy(asc(liability.position), asc(liability.name), asc(liability.id)),
  );
}

/** Creates a liability inside a transaction; the currency defaults to the household's. No role check. */
export async function createLiabilityInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateLiabilityInput,
): Promise<Liability> {
  const input = parseInput(createSchema, rawInput);
  assertLinkAllowed(input.kind, input.assetId);
  await requireLinks(tx, householdId, input);
  let currency = input.currency;
  if (!currency) {
    const [settings] = await tx
      .select({ currency: householdSettings.currency })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    currency = settings?.currency ?? 'EUR';
  }
  const [row] = await tx
    .insert(liability)
    .values({ ...input, currency, householdId })
    .returning();
  return row!;
}

/** Creates a liability; the currency defaults to the household's. */
export async function createLiability(
  ctx: ServiceCtx,
  rawInput: CreateLiabilityInput,
): Promise<Liability> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createLiabilityInTx(tx, ctx.householdId, rawInput),
  );
}

/** Patch fields that move the liability's past balances (everything but names and order). */
const SNAPSHOT_FIELDS = [
  'accountId',
  'assetId',
  'principal',
  'annualRateBps',
  'termMonths',
  'startDate',
] as const;

/** Updates a liability inside a transaction. No role check. */
export async function updateLiabilityInTx(
  tx: Tx,
  householdId: string,
  id: string,
  rawPatch: UpdateLiabilityPatch,
): Promise<Liability> {
  assertUuid(id, 'Liability');
  const patch = parseInput(patchSchema, rawPatch);
  const cur = await requireLiability(tx, householdId, id);
  if (patch.kind !== undefined || patch.assetId !== undefined) {
    assertLinkAllowed(
      patch.kind ?? cur.kind,
      patch.assetId !== undefined ? patch.assetId : cur.assetId,
    );
  }
  await requireLinks(tx, householdId, patch, id, cur.assetId);
  if (Object.keys(patch).length === 0) return cur;
  const [row] = await tx
    .update(liability)
    .set(patch)
    .where(and(eq(liability.id, id), eq(liability.householdId, householdId)))
    .returning();
  if (!row) throw new NotFoundError('Liability');
  // A link or a schedule input changes what the liability owed in past months too.
  if (SNAPSHOT_FIELDS.some((f) => patch[f] !== undefined)) {
    await refreshAllStoredSnapshotsInTx(tx, householdId);
  }
  return row;
}

export async function updateLiability(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateLiabilityPatch,
): Promise<Liability> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    updateLiabilityInTx(tx, ctx.householdId, id, rawPatch),
  );
}

/**
 * Marks a liability settled in full on `date` (not after today in the household's time zone).
 * Without an account it also records a zero balance that day, unless a balance is already there.
 * Stored net worth is recomputed unless `refresh` is false (the caller then does it). No role check.
 */
export async function settleLiabilityInTx(
  tx: Tx,
  householdId: string,
  id: string,
  date: string,
  opts: { refresh?: boolean } = {},
): Promise<Liability> {
  assertUuid(id, 'Liability');
  const day = parseInput(calendarDate, date);
  const { today } = await householdClock(tx, householdId, new Date());
  if (day > today) {
    throw new ValidationError(
      'A liability cannot be settled in the future',
      [{ path: ['date'], message: 'in the future' }],
      'date_in_future',
    );
  }
  const [row] = await tx
    .update(liability)
    .set({ settledOn: day })
    .where(
      and(
        eq(liability.id, id),
        eq(liability.householdId, householdId),
        isNull(liability.settledOn),
      ),
    )
    .returning();
  if (!row) {
    await requireLiability(tx, householdId, id);
    throw new ValidationError('The liability is already settled', [], 'liability_already_settled');
  }
  if (!row.accountId) {
    await tx
      .insert(liabilityBalance)
      .values({ householdId, liabilityId: id, asOf: day, balance: 0, source: 'manual' })
      .onConflictDoNothing({ target: [liabilityBalance.liabilityId, liabilityBalance.asOf] });
  }
  if (opts.refresh !== false) await refreshAllStoredSnapshotsInTx(tx, householdId);
  return row;
}

const settleSchema = z.strictObject({ date: calendarDate });

/** Settles a liability on a date (see `settleLiabilityInTx`). */
export async function settleLiability(
  ctx: ServiceCtx,
  id: string,
  rawInput: z.input<typeof settleSchema>,
  opts: WriteOpts<Liability> = {},
): Promise<Liability> {
  assertCanWrite(ctx);
  assertUuid(id, 'Liability');
  const input = parseInput(settleSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const row = await settleLiabilityInTx(tx, ctx.householdId, id, input.date);
    await opts.onCommit?.(tx, row);
    return row;
  });
}

/** Reopens a settled liability. The zero balance written on settling stays. */
export async function unsettleLiability(
  ctx: ServiceCtx,
  id: string,
  opts: WriteOpts<Liability> = {},
): Promise<Liability> {
  assertCanWrite(ctx);
  assertUuid(id, 'Liability');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const cur = await requireLiability(tx, ctx.householdId, id);
    // Another record may have taken the account while this one was settled.
    if (cur.settledOn && cur.accountId) {
      await assertAccountUnclaimed(tx, ctx.householdId, cur.accountId, { side: 'liability', id });
    }
    const [row] = await tx
      .update(liability)
      .set({ settledOn: null })
      .where(
        and(
          eq(liability.id, id),
          eq(liability.householdId, ctx.householdId),
          isNotNull(liability.settledOn),
        ),
      )
      .returning();
    if (!row) {
      await requireLiability(tx, ctx.householdId, id);
      throw new ValidationError('The liability is not settled', [], 'liability_not_settled');
    }
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await opts.onCommit?.(tx, row);
    return row;
  });
}

/** Deletes a liability and its balances (owner only). */
export async function deleteLiability(
  ctx: ServiceCtx,
  id: string,
  opts: WriteOpts<Liability> = {},
): Promise<void> {
  assertOwner(ctx);
  assertUuid(id, 'Liability');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .delete(liability)
      .where(and(eq(liability.id, id), eq(liability.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Liability');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await opts.onCommit?.(tx, row);
  });
}

/**
 * Writes spreadsheet-imported balances (`source = 'import'`) inside a transaction. A day that
 * already holds an import-sourced balance takes the new one; a day holding a manual, connector or
 * schedule balance is left exactly as it is. No role check.
 */
export async function replaceImportedBalancesInTx(
  tx: Tx,
  householdId: string,
  liabilityId: string,
  balances: Array<{ asOf: string; balance: number }>,
): Promise<void> {
  if (balances.length === 0) return;
  const rows = balances.map((b) => {
    const input = parseInput(storedBalanceSchema, { ...b, source: 'import' });
    return {
      householdId,
      liabilityId,
      asOf: input.asOf,
      balance: input.balance,
      source: 'import' as const,
    };
  });
  await tx
    .insert(liabilityBalance)
    .values(rows)
    .onConflictDoUpdate({
      target: [liabilityBalance.liabilityId, liabilityBalance.asOf],
      set: { balance: sql`excluded.balance` },
      setWhere: eq(liabilityBalance.source, 'import'),
    });
}

/** Soft-removes a liability (its balances stay). Idempotent. */
export async function archiveLiability(ctx: ServiceCtx, id: string): Promise<Liability> {
  assertCanWrite(ctx);
  assertUuid(id, 'Liability');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .update(liability)
      .set({ archived: true })
      .where(and(eq(liability.id, id), eq(liability.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Liability');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    return row;
  });
}

/** Balances of a liability, newest first (read: any role). */
export async function listLiabilityBalances(
  ctx: ServiceCtx,
  liabilityId: string,
): Promise<LiabilityBalance[]> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireLiability(tx, ctx.householdId, liabilityId);
    return tx
      .select()
      .from(liabilityBalance)
      .where(
        and(
          eq(liabilityBalance.liabilityId, liabilityId),
          eq(liabilityBalance.householdId, ctx.householdId),
        ),
      )
      .orderBy(desc(liabilityBalance.asOf));
  });
}

/**
 * Records a manual amount owed on a day; a second one for the same day replaces the first. Stored
 * net worth months from that day's month on are recomputed.
 */
export async function addLiabilityBalance(
  ctx: ServiceCtx,
  liabilityId: string,
  rawInput: LiabilityBalanceInput,
): Promise<LiabilityBalance> {
  assertCanWrite(ctx);
  assertUuid(liabilityId, 'Liability');
  const input = parseInput(balanceSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireLiability(tx, ctx.householdId, liabilityId);
    const values = {
      balance: input.balance,
      source: 'manual' as const,
      note: input.note ?? null,
    };
    const [row] = await tx
      .insert(liabilityBalance)
      .values({ householdId: ctx.householdId, liabilityId, asOf: input.asOf, ...values })
      .onConflictDoUpdate({
        target: [liabilityBalance.liabilityId, liabilityBalance.asOf],
        set: values,
      })
      .returning();
    await refreshStoredSnapshotsInTx(tx, ctx.householdId, input.asOf);
    return row!;
  });
}

/** Deletes a balance; stored net worth months from its month on are recomputed. */
export async function deleteLiabilityBalance(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Balance');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .delete(liabilityBalance)
      .where(and(eq(liabilityBalance.id, id), eq(liabilityBalance.householdId, ctx.householdId)))
      .returning({ asOf: liabilityBalance.asOf });
    if (!row) throw new NotFoundError('Balance');
    await refreshStoredSnapshotsInTx(tx, ctx.householdId, row.asOf);
  });
}

/** Sets the four amortisation inputs together (principal, yearly rate, term, first day). */
export async function saveLiabilitySchedule(
  ctx: ServiceCtx,
  liabilityId: string,
  rawInput: LiabilityScheduleInput,
): Promise<Liability> {
  assertCanWrite(ctx);
  assertUuid(liabilityId, 'Liability');
  const input = parseInput(scheduleSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .update(liability)
      .set(input)
      .where(and(eq(liability.id, liabilityId), eq(liability.householdId, ctx.householdId)))
      .returning();
    if (!row) throw new NotFoundError('Liability');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    return row;
  });
}

/** The full repayment schedule of a liability, or null when it has none (read: any role). */
export async function scheduleFor(
  ctx: ServiceCtx,
  liabilityId: string,
): Promise<LiabilitySchedule | null> {
  const row = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    requireLiability(tx, ctx.householdId, liabilityId),
  );
  const params = scheduleParamsOf(row);
  if (!params) return null;
  return {
    params,
    payment: annuityPayment(params.principal, params.annualRateBps, params.termMonths),
    rows: amortisationSchedule(params),
  };
}
