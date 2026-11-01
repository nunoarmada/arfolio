import { and, asc, eq, gte, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  addCadence,
  addDays,
  CADENCE_INTERVALS,
  daysBetween,
  detectRecurring,
  isNextOccurrence,
  merchantKey as textKey,
  monthlyEquivalent,
  normalizeDescription,
  RECURRING_LOOKBACK_DAYS,
  withinTolerance,
  type DetectedRecurring,
} from '@arfolio/core';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import { isUniqueViolation, requireAccount } from './budgets.js';
import {
  assertCanWrite,
  assertUuid,
  currencyCode,
  isoDate,
  MAX_AMOUNT_MINOR,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { createNotificationInTx } from './notifications.js';
import { localDay } from './sync.js';
import { findTransferCategory } from './transactions.js';

const { recurring, transaction, merchant, householdSettings, organization } = schema;

export type Recurring = typeof recurring.$inferSelect;
export type RecurringCadence = Recurring['cadence'];

const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
const DETECTED_UNIQUE = 'recurring_detected_merchant_cadence_unique';
/** Days after the expected date before a missing payment is reported. */
const MISSED_GRACE_DAYS = 5;

// ---------------------------------------------------------------------------------------------
// Input schemas

const amountField = z
  .number()
  .int()
  .min(-MAX_AMOUNT_MINOR)
  .max(MAX_AMOUNT_MINOR)
  .refine((n) => n !== 0, 'amount must not be zero');
const nameField = z.string().trim().min(1).max(120);

const declareSchema = z.strictObject({
  name: nameField,
  /** Signed minor units: an expense is negative. */
  amount: amountField,
  cadence: z.enum(CADENCES),
  currency: currencyCode.optional(),
  accountId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  budgetLineId: z.string().nullable().optional(),
  nextExpectedOn: isoDate.nullable().optional(),
});

const updateSchema = z.strictObject({
  name: nameField.optional(),
  amount: amountField.optional(),
  cadence: z.enum(CADENCES).optional(),
  accountId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  budgetLineId: z.string().nullable().optional(),
  nextExpectedOn: isoDate.nullable().optional(),
});

const listSchema = z.strictObject({ includeDismissed: z.boolean().optional() });

export type DeclareRecurringInput = z.input<typeof declareSchema>;
export type UpdateRecurringPatch = z.input<typeof updateSchema>;

// ---------------------------------------------------------------------------------------------
// Detection (system job: runs per household, no user role)

export type RecurringDetectionDeps = { db: Db; now?: Date };
export type RecurringDetectionResult = {
  /** New `detected` rows. */
  created: number;
  /** Existing rows whose amount, account or dates changed. */
  updated: number;
  missed: number;
  priceChanges: number;
};

type Latest = { date: string; amount: number };

/** Every household, for the daily job to queue one detection per household. */
export async function findRecurringHouseholds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: organization.id }).from(organization);
  return rows.map((r) => r.id);
}

/** Detected-but-unconfirmed rows are guesses: they never notify and never count towards cost. */
const isEstablished = (row: Pick<Recurring, 'status' | 'source'>): boolean =>
  row.status === 'confirmed' || (row.status !== 'dismissed' && row.source !== 'detected');

/** The normalised name inside a `d:` (detected or declared) or `i:` (imported) key. */
const keyText = (key: string): string => (/^[di]:/.test(key) ? key.slice(2) : key);

/**
 * Looks at the last 400 days of booked outgoing non-transfer transactions in the household
 * currency, and upserts what repeats on a cadence. Safe to run every day: it never resurrects a
 * dismissed item, only moves the dates of confirmed or declared ones, and notifications are
 * deduplicated, so a rerun changes nothing.
 */
export async function runRecurringDetection(
  deps: RecurringDetectionDeps,
  householdId: string,
): Promise<RecurringDetectionResult> {
  const now = deps.now ?? new Date();
  return withHousehold(deps.db, householdId, async (tx) => {
    const [settings] = await tx
      .select({ currency: householdSettings.currency, timezone: householdSettings.timezone })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    const currency = settings?.currency ?? 'EUR';
    const today = localDay(now, settings?.timezone ?? 'UTC');

    const txRows = await outgoingRows(
      tx,
      householdId,
      currency,
      addDays(today, -RECURRING_LOOKBACK_DAYS),
    );
    const latestByKey = new Map<string, Latest>();
    const nameByKey = new Map<string, string>();
    for (const r of txRows) {
      const seen = latestByKey.get(r.merchantKey);
      if (!seen || r.bookingDate >= seen.date) {
        latestByKey.set(r.merchantKey, { date: r.bookingDate, amount: r.amount });
        nameByKey.set(r.merchantKey, r.name);
      }
    }
    const detected = new Map<string, DetectedRecurring>();
    for (const d of detectRecurring(txRows, today))
      detected.set(`${d.merchantKey}|${d.cadence}`, d);

    const existing = await tx
      .select()
      .from(recurring)
      .where(eq(recurring.householdId, householdId));
    const result: RecurringDetectionResult = { created: 0, updated: 0, missed: 0, priceChanges: 0 };

    /**
     * The stored last-seen date moves forward only: to the detection, then to a later payment.
     * With no date at all (a declared item), a payment is adopted only when it is recent and
     * close to the item's amount, so an old unrelated charge never starts the clock.
     */
    const resolveLastSeen = (
      stored: string | null,
      found: string | undefined,
      key: string,
      cadence: RecurringCadence,
      amount: number,
    ): string | null => {
      let base = [stored, found ?? null].reduce<string | null>(
        (a, b) => (a === null ? b : b !== null && b > a ? b : a),
        null,
      );
      const latest = latestByKey.get(key);
      if (!latest) return base;
      if (base === null) {
        const recent =
          daysBetween(latest.date, today) <= CADENCE_INTERVALS[cadence][1] + MISSED_GRACE_DAYS;
        return recent && withinTolerance(latest.amount, amount) ? latest.date : null;
      }
      if (isNextOccurrence(base, latest.date, cadence)) base = latest.date;
      return base;
    };

    const inserted = new Set<string>();
    for (const d of detected.values()) {
      // Handled below when a row exists; a dismissed one blocks a new row, and a confirmed or
      // user-created row blocks a detected duplicate whatever its cadence.
      const blocked = existing.some(
        (r) =>
          (r.merchantKey === d.merchantKey ||
            (r.source !== 'detected' && keyText(r.merchantKey) === keyText(d.merchantKey))) &&
          (r.cadence === d.cadence || r.status === 'confirmed' || r.source !== 'detected'),
      );
      if (blocked) continue;
      const lastSeenOn =
        resolveLastSeen(null, d.lastSeenOn, d.merchantKey, d.cadence, d.typicalAmount) ??
        d.lastSeenOn;
      const [row] = await tx
        .insert(recurring)
        .values({
          householdId,
          accountId: d.accountId,
          merchantKey: d.merchantKey,
          name: nameByKey.get(d.merchantKey) ?? d.merchantKey,
          amount: d.typicalAmount,
          currency,
          cadence: d.cadence,
          lastSeenOn,
          nextExpectedOn: addCadence(lastSeenOn, d.cadence),
          status: 'detected',
          source: 'detected',
        })
        .returning();
      existing.push(row!);
      inserted.add(row!.id);
      result.created += 1;
    }

    for (const row of existing) {
      if (row.status === 'dismissed') continue;
      const found = detected.get(`${row.merchantKey}|${row.cadence}`);
      const patch: Partial<typeof recurring.$inferInsert> = {};
      // Fields the user owns (confirmed or declared) are never overwritten by detection.
      if (found && row.source === 'detected' && row.status === 'detected') {
        if (found.typicalAmount !== row.amount) patch.amount = found.typicalAmount;
        if (found.accountId !== row.accountId) patch.accountId = found.accountId;
      }
      const lastSeenOn = resolveLastSeen(
        row.lastSeenOn,
        found?.lastSeenOn,
        row.merchantKey,
        row.cadence,
        patch.amount ?? row.amount,
      );
      if (lastSeenOn !== null && lastSeenOn !== row.lastSeenOn) {
        patch.lastSeenOn = lastSeenOn;
        // A date the user set is never pulled earlier by a detected payment.
        const next = addCadence(lastSeenOn, row.cadence);
        if (row.nextExpectedOn === null || next > row.nextExpectedOn) patch.nextExpectedOn = next;
      }
      const effective = { ...row, ...patch };
      if (Object.keys(patch).length > 0) {
        await tx
          .update(recurring)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(recurring.id, row.id));
        if (!inserted.has(row.id)) result.updated += 1;
      }
      if (!isEstablished(effective)) continue;

      const next = effective.nextExpectedOn;
      if (next && today > addDays(next, MISSED_GRACE_DAYS)) {
        const created = await createNotificationInTx(tx, {
          householdId,
          kind: 'recurring_missed',
          payload: {
            recurringId: row.id,
            name: row.name,
            expectedOn: next,
            amount: effective.amount,
            currency: row.currency,
          },
          dedupeKey: `recurring-missed:${row.id}:${next}`,
        });
        if (created) result.missed += 1;
      }

      const latest = latestByKey.get(row.merchantKey);
      if (
        latest &&
        latest.date === effective.lastSeenOn &&
        row.currency === currency &&
        Math.abs(latest.amount - effective.amount) * 10 > Math.abs(effective.amount)
      ) {
        const created = await createNotificationInTx(tx, {
          householdId,
          kind: 'recurring_price_change',
          payload: {
            recurringId: row.id,
            name: row.name,
            previousAmount: effective.amount,
            amount: latest.amount,
            currency: row.currency,
            date: latest.date,
          },
          dedupeKey: `recurring-price:${row.id}:${latest.date.slice(0, 7)}:${latest.amount}`,
        });
        if (created) result.priceChanges += 1;
        // The item now carries the new price (detection never touches an established row's
        // amount), so the same price next month is not a change again.
        await tx
          .update(recurring)
          .set({ amount: latest.amount, updatedAt: new Date() })
          .where(eq(recurring.id, row.id));
        // A row already counted as updated (or just created) above is not counted twice.
        if (Object.keys(patch).length === 0 && !inserted.has(row.id)) result.updated += 1;
      }
    }
    return result;
  });
}

/** Booked, outgoing, non-transfer transactions in `currency` since `since`, keyed per merchant. */
async function outgoingRows(tx: Tx, householdId: string, currency: string, since: string) {
  const transferCategory = await findTransferCategory(tx, householdId);
  const rows = await tx
    .select({
      merchantId: transaction.merchantId,
      merchantName: merchant.displayName,
      counterparty: transaction.counterparty,
      rawDescription: transaction.rawDescription,
      accountId: transaction.accountId,
      // Detection runs on the purchase day: a card statement books a month of charges on one day.
      bookingDate: transaction.purchaseDate,
      amount: transaction.amount,
    })
    .from(transaction)
    .leftJoin(
      merchant,
      and(
        eq(merchant.id, transaction.merchantId),
        eq(merchant.householdId, transaction.householdId),
      ),
    )
    .where(
      and(
        eq(transaction.householdId, householdId),
        eq(transaction.status, 'booked'),
        eq(transaction.currency, currency),
        gte(transaction.purchaseDate, since),
        lt(transaction.amount, 0),
        isNull(transaction.transferGroupId),
        transferCategory
          ? or(isNull(transaction.categoryId), ne(transaction.categoryId, transferCategory))
          : undefined,
      ),
    )
    .orderBy(asc(transaction.purchaseDate), asc(transaction.amount), asc(transaction.id));
  const keyed: Array<{
    merchantKey: string;
    name: string;
    accountId: string;
    bookingDate: string;
    amount: number;
  }> = [];
  for (const r of rows) {
    const text = textKey(r.rawDescription, r.counterparty);
    // The text key alone identifies a series: a merchant link applied mid-history must not split
    // it. The merchant only supplies the display name.
    if (!text) continue;
    keyed.push({
      merchantKey: `d:${text}`,
      name: r.merchantName ?? (r.counterparty?.trim() || r.rawDescription.trim()),
      accountId: r.accountId,
      bookingDate: r.bookingDate,
      amount: r.amount,
    });
  }
  return keyed;
}

// ---------------------------------------------------------------------------------------------
// Reading and mutating (any role reads; writers mutate)

/** Active items by default (detected and confirmed), soonest expected first. */
export async function listRecurring(
  ctx: ServiceCtx,
  rawOpts: z.input<typeof listSchema> = {},
): Promise<Recurring[]> {
  const opts = parseInput(listSchema, rawOpts);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(recurring)
      .where(
        and(
          eq(recurring.householdId, ctx.householdId),
          opts.includeDismissed ? undefined : ne(recurring.status, 'dismissed'),
        ),
      )
      .orderBy(asc(recurring.nextExpectedOn), asc(recurring.name), asc(recurring.id)),
  );
}

/**
 * What the confirmed and declared items cost per month, as a positive number in the household
 * currency (each item normalised to a month and rounded half away from zero). Unconfirmed
 * detections, dismissed items, income and other currencies are left out.
 */
export async function recurringMonthlyCost(
  ctx: ServiceCtx,
): Promise<{ currency: string; amount: number }> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [settings] = await tx
      .select({ currency: householdSettings.currency })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    const currency = settings?.currency ?? 'EUR';
    const rows = await tx
      .select()
      .from(recurring)
      .where(and(eq(recurring.householdId, ctx.householdId), eq(recurring.currency, currency)));
    let amount = 0;
    for (const r of rows) {
      if (isEstablished(r) && r.amount < 0) amount -= monthlyEquivalent(r.amount, r.cadence);
    }
    return { currency, amount };
  });
}

async function requireOwned(
  tx: Tx,
  householdId: string,
  ids: { accountId?: string | null; categoryId?: string | null; budgetLineId?: string | null },
): Promise<void> {
  if (ids.accountId) await requireAccount(tx, householdId, ids.accountId);
  if (ids.categoryId) {
    assertUuid(ids.categoryId, 'Category');
    const [row] = await tx
      .select({ id: schema.category.id })
      .from(schema.category)
      .where(
        and(eq(schema.category.id, ids.categoryId), eq(schema.category.householdId, householdId)),
      );
    if (!row) throw new NotFoundError('Category');
  }
  if (ids.budgetLineId) {
    assertUuid(ids.budgetLineId, 'Budget line');
    const [row] = await tx
      .select({ id: schema.budgetLine.id })
      .from(schema.budgetLine)
      .where(
        and(
          eq(schema.budgetLine.id, ids.budgetLineId),
          eq(schema.budgetLine.householdId, householdId),
        ),
      );
    if (!row) throw new NotFoundError('Budget line');
  }
}

/** Adds an item the user knows about (confirmed, source `declared`). */
export async function declareRecurring(
  ctx: ServiceCtx,
  rawInput: DeclareRecurringInput,
): Promise<Recurring> {
  assertCanWrite(ctx);
  const input = parseInput(declareSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireOwned(tx, ctx.householdId, input);
    const [settings] = await tx
      .select({ currency: householdSettings.currency })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    const [row] = await tx
      .insert(recurring)
      .values({
        householdId: ctx.householdId,
        accountId: input.accountId ?? null,
        merchantKey: `d:${normalizeDescription(input.name) || input.name}`,
        name: input.name,
        amount: input.amount,
        currency: input.currency ?? settings?.currency ?? 'EUR',
        cadence: input.cadence,
        nextExpectedOn: input.nextExpectedOn ?? null,
        status: 'confirmed',
        source: 'declared',
        categoryId: input.categoryId ?? null,
        budgetLineId: input.budgetLineId ?? null,
      })
      .returning();
    return row!;
  });
}

type MutableFields = Partial<Omit<typeof recurring.$inferInsert, 'status'>> & {
  status?: Recurring['status'] | SQL;
};

async function mutate(
  ctx: ServiceCtx,
  id: string,
  set: MutableFields,
  check?: (tx: Tx) => Promise<void>,
): Promise<Recurring> {
  assertUuid(id, 'Recurring item');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await check?.(tx);
    try {
      const [row] = await tx
        .update(recurring)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(recurring.id, id), eq(recurring.householdId, ctx.householdId)))
        .returning();
      if (!row) throw new NotFoundError('Recurring item');
      return row;
    } catch (err) {
      if (isUniqueViolation(err, DETECTED_UNIQUE)) {
        throw new ValidationError('A detected item with this merchant and cadence already exists');
      }
      throw err;
    }
  });
}

/** Edits the user-owned fields. Omitted fields are left as they are. */
export async function updateRecurring(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateRecurringPatch,
): Promise<Recurring> {
  assertCanWrite(ctx);
  const patch = parseInput(updateSchema, rawPatch);
  // A user edit of a detected item is a confirmation: detection must stop overwriting it.
  const set: MutableFields = {
    status: sql`case when ${recurring.status} = 'detected' then 'confirmed' else ${recurring.status} end`,
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  return mutate(ctx, id, set, (tx) => requireOwned(tx, ctx.householdId, patch));
}

/** Marks an item as a real recurring payment. Idempotent. */
export async function confirmRecurring(ctx: ServiceCtx, id: string): Promise<Recurring> {
  assertCanWrite(ctx);
  return mutate(ctx, id, { status: 'confirmed' });
}

/** Hides an item for good: detection never brings it back. Idempotent. */
export async function dismissRecurring(ctx: ServiceCtx, id: string): Promise<Recurring> {
  assertCanWrite(ctx);
  return mutate(ctx, id, { status: 'dismissed' });
}

/**
 * Undoes a confirm or a dismiss: a detection that was confirmed or dismissed goes back to
 * `detected`. Declared and imported items were never detections, so there is nothing to go back to
 * (`not_reopenable`). Idempotent for an item that is already `detected`.
 */
export async function reopenRecurring(ctx: ServiceCtx, id: string): Promise<Recurring> {
  assertCanWrite(ctx);
  assertUuid(id, 'Recurring item');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(recurring)
      .where(and(eq(recurring.id, id), eq(recurring.householdId, ctx.householdId)))
      .for('update');
    if (!row) throw new NotFoundError('Recurring item');
    if (row.source !== 'detected') {
      throw new ValidationError('Only detected items can be reopened', [], 'not_reopenable');
    }
    if (row.status === 'detected') return row;
    const [updated] = await tx
      .update(recurring)
      .set({ status: 'detected', updatedAt: new Date() })
      .where(and(eq(recurring.id, id), eq(recurring.householdId, ctx.householdId)))
      .returning();
    return updated!;
  });
}
