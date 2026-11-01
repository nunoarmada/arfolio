import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  budgetMonths,
  computeTransferPlan,
  isValidTimezone,
  investedDelta,
  type BudgetKind,
  type BudgetMonth,
  type InvestedDelta,
  type TransferPlan,
} from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertOwner,
  assertUuid,
  ConflictError,
  isoDate,
  MAX_AMOUNT_MINOR,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { TRANSFER_CATEGORY_KEY } from './category-templates.js';
import { loadSnapshotDays, shiftDay, todayInZone } from './budget-buckets.js';
import { findTransferCategory } from './transactions.js';

const {
  budget,
  budgetLine,
  budgetLineCategory,
  budgetLineBucket,
  investmentBucket,
  budgetAmount,
  householdSettings,
  financialAccount,
  category,
  categoryGroup,
} = schema;

export type Budget = typeof budget.$inferSelect;
export type BudgetLine = typeof budgetLine.$inferSelect;
export type BudgetLineDetail = BudgetLine & {
  /** Planned amounts for months 1..12 (0 where none is stored). */
  amounts: number[];
  categoryIds: string[];
  /** Investment pies (buckets) whose invested money counts as the (saving) line's actuals. */
  bucketIds: string[];
};
export type BudgetDetail = Budget & { lines: BudgetLineDetail[] };

const KINDS: readonly BudgetKind[] = ['income', 'expense', 'saving'];

// ---------------------------------------------------------------------------------------------
// Input schemas

const startMonthField = isoDate.refine((d) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, day));
  return day === 1 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1;
}, 'expected the first day of a month');

const createBudgetSchema = z.strictObject({
  startMonth: startMonthField,
  name: z.string().trim().min(1).max(120).optional(),
  copyFromBudgetId: z.string().optional(),
});

const lineSchema = z.strictObject({
  id: z.string().optional(),
  kind: z.enum(KINDS as [BudgetKind, ...BudgetKind[]]),
  name: z.string().trim().min(1).max(120),
  groupId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  position: z.number().int().min(0).max(32_767).optional(),
  notes: z.string().trim().min(1).max(2_000).nullable().optional(),
});

const budgetNameSchema = z.string().trim().min(1).max(80);
const thresholdsSchema = z
  .array(z.number().int().min(1).max(200))
  .max(5)
  .refine((v) => new Set(v).size === v.length, 'thresholds must be unique');
const fiscalMonthSchema = z.number().int().min(1).max(12);

const amountsSchema = z.array(z.number().int().safe().min(0).max(MAX_AMOUNT_MINOR)).length(12);
const monthIndexSchema = z.number().int().min(1).max(12);

export type CreateBudgetInput = z.input<typeof createBudgetSchema>;
export type UpsertBudgetLineInput = z.input<typeof lineSchema>;
export type SaveBudgetLineInput = {
  line: UpsertBudgetLineInput;
  /** Planned amounts for months 1..12. */
  amounts: number[];
  categoryIds: string[];
  /** Linked buckets; omitted means none (replace semantics, like the categories). */
  bucketIds?: string[];
};

// ---------------------------------------------------------------------------------------------
// Tx-level helpers (no role checks; re-exported from internal.ts, not from the package barrel)

type Actor = { householdId: string; userId: string };

/** True when `err` (or a wrapped cause) is a unique violation (23505) of the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const { code, constraint: name } = e as { code?: string; constraint?: string };
    if (code === '23505' && name === constraint) return true;
  }
  return false;
}

/** Aggregates arrive as numeric text; refuse to round them into a wrong number. */
export function toSafeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Amount is not a safe integer: ${value}`);
  return n;
}

const LINE_NAME_CONSTRAINT = 'budget_line_budget_kind_name_unique';
const LINK_CONSTRAINT = 'budget_line_category_budget_category_unique';
const linkConflict = () =>
  new ConflictError(
    'category_already_linked',
    'A category is already linked to another line of this budget',
  );
const BUCKET_CONSTRAINT = 'budget_line_bucket_budget_bucket_unique';
const bucketConflict = () =>
  new ConflictError(
    'bucket_already_linked',
    'A bucket is already linked to another line of this budget',
  );

/** "2026" for a calendar-year budget, "2026/27" when the year spans two calendar years. */
function defaultBudgetName(startMonth: string): string {
  const [year, month] = startMonth.split('-').map(Number) as [number, number];
  return month === 1 ? String(year) : `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

async function requireBudget(tx: Tx, householdId: string, id: string): Promise<Budget> {
  assertUuid(id, 'Budget');
  const [row] = await tx
    .select()
    .from(budget)
    .where(and(eq(budget.id, id), eq(budget.householdId, householdId)));
  if (!row) throw new NotFoundError('Budget');
  return row;
}

async function requireLine(tx: Tx, householdId: string, id: string): Promise<BudgetLine> {
  assertUuid(id, 'Budget line');
  const [row] = await tx
    .select()
    .from(budgetLine)
    .where(and(eq(budgetLine.id, id), eq(budgetLine.householdId, householdId)));
  if (!row) throw new NotFoundError('Budget line');
  return row;
}

/**
 * Creates a budget, optionally copying the lines, category links and amounts of another budget of
 * the same household. A second budget for the same start month is a `budget_exists` error.
 */
export async function createBudgetInTx(
  tx: Tx,
  actor: Actor,
  rawInput: CreateBudgetInput,
): Promise<Budget> {
  const input = parseInput(createBudgetSchema, rawInput);
  const source = input.copyFromBudgetId
    ? await requireBudget(tx, actor.householdId, input.copyFromBudgetId)
    : null;

  const [created] = await tx
    .insert(budget)
    .values({
      householdId: actor.householdId,
      startMonth: input.startMonth,
      name: input.name ?? defaultBudgetName(input.startMonth),
      createdBy: actor.userId,
    })
    .onConflictDoNothing({ target: [budget.householdId, budget.startMonth] })
    .returning();
  if (!created) {
    throw new ValidationError('A budget already exists for this start month', [], 'budget_exists');
  }
  if (source) await copyBudgetContents(tx, actor.householdId, source.id, created.id);
  return created;
}

async function copyBudgetContents(
  tx: Tx,
  householdId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  const lines = await tx
    .select()
    .from(budgetLine)
    .where(and(eq(budgetLine.budgetId, fromId), eq(budgetLine.householdId, householdId)));
  if (lines.length === 0) return;
  const idMap = new Map(lines.map((l) => [l.id, randomUUID()]));
  await tx.insert(budgetLine).values(
    lines.map((l) => ({
      id: idMap.get(l.id)!,
      householdId,
      budgetId: toId,
      kind: l.kind,
      name: l.name,
      groupId: l.groupId,
      accountId: l.accountId,
      position: l.position,
      notes: l.notes,
    })),
  );
  const oldIds = [...idMap.keys()];
  const amounts = await tx
    .select()
    .from(budgetAmount)
    .where(
      and(eq(budgetAmount.householdId, householdId), inArray(budgetAmount.budgetLineId, oldIds)),
    );
  if (amounts.length > 0) {
    await tx.insert(budgetAmount).values(
      amounts.map((a) => ({
        budgetLineId: idMap.get(a.budgetLineId)!,
        householdId,
        monthIndex: a.monthIndex,
        amount: a.amount,
      })),
    );
  }
  const links = await tx
    .select()
    .from(budgetLineCategory)
    .where(
      and(eq(budgetLineCategory.budgetId, fromId), eq(budgetLineCategory.householdId, householdId)),
    );
  if (links.length > 0) {
    await tx.insert(budgetLineCategory).values(
      links.map((k) => ({
        budgetLineId: idMap.get(k.budgetLineId)!,
        categoryId: k.categoryId,
        budgetId: toId,
        householdId,
      })),
    );
  }
  const bucketLinks = await tx
    .select()
    .from(budgetLineBucket)
    .where(
      and(eq(budgetLineBucket.budgetId, fromId), eq(budgetLineBucket.householdId, householdId)),
    );
  if (bucketLinks.length > 0) {
    await tx.insert(budgetLineBucket).values(
      bucketLinks.map((k) => ({
        budgetLineId: idMap.get(k.budgetLineId)!,
        bucketId: k.bucketId,
        budgetId: toId,
        householdId,
      })),
    );
  }
}

async function requireGroup(tx: Tx, householdId: string, id: string): Promise<void> {
  assertUuid(id, 'Category group');
  const [row] = await tx
    .select({ id: categoryGroup.id })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, id), eq(categoryGroup.householdId, householdId)));
  if (!row) throw new NotFoundError('Category group');
}

export async function requireAccount(tx: Tx, householdId: string, id: string): Promise<void> {
  assertUuid(id, 'Account');
  const [row] = await tx
    .select({ id: financialAccount.id })
    .from(financialAccount)
    .where(and(eq(financialAccount.id, id), eq(financialAccount.householdId, householdId)));
  if (!row) throw new NotFoundError('Account');
}

/**
 * Creates or updates a line. With `id` that line is updated; otherwise the line is identified by
 * (budget, kind, name) and updated in place when it exists. Omitted optional fields are left as
 * they are on update.
 */
export async function upsertBudgetLineInTx(
  tx: Tx,
  householdId: string,
  budgetId: string,
  rawInput: UpsertBudgetLineInput,
): Promise<BudgetLine> {
  const input = parseInput(lineSchema, rawInput);
  await requireBudget(tx, householdId, budgetId);
  if (input.groupId) await requireGroup(tx, householdId, input.groupId);
  if (input.accountId) await requireAccount(tx, householdId, input.accountId);

  const optional = {
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
  };

  if (input.id) {
    assertUuid(input.id, 'Budget line');
    try {
      const [row] = await tx
        .update(budgetLine)
        .set({ kind: input.kind, name: input.name, ...optional })
        .where(
          and(
            eq(budgetLine.id, input.id),
            eq(budgetLine.budgetId, budgetId),
            eq(budgetLine.householdId, householdId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundError('Budget line');
      return row;
    } catch (err) {
      if (isUniqueViolation(err, LINE_NAME_CONSTRAINT)) {
        throw new ValidationError(
          'Another line of this budget already has this kind and name',
          [],
          'line_name_taken',
        );
      }
      throw err;
    }
  }

  const position =
    input.position ??
    (
      await tx
        .select({ next: sql<number>`coalesce(max(${budgetLine.position}) + 1, 0)::int` })
        .from(budgetLine)
        .where(and(eq(budgetLine.budgetId, budgetId), eq(budgetLine.householdId, householdId)))
    )[0]!.next;
  const [row] = await tx
    .insert(budgetLine)
    .values({
      householdId,
      budgetId,
      kind: input.kind,
      name: input.name,
      ...optional,
      position,
    })
    .onConflictDoUpdate({
      target: [budgetLine.budgetId, budgetLine.kind, budgetLine.name],
      // `name` is part of the conflict key, so re-setting it is a no-op that keeps the set non-empty.
      set: { name: input.name, ...optional },
    })
    .returning();
  return row!;
}

/** Replaces the 12 planned amounts of a line (month 1 = the budget's start month). */
export async function setLineAmountsInTx(
  tx: Tx,
  householdId: string,
  lineId: string,
  rawAmounts: number[],
): Promise<void> {
  const amounts = parseInput(amountsSchema, rawAmounts);
  await requireLine(tx, householdId, lineId);
  await tx
    .insert(budgetAmount)
    .values(
      amounts.map((amount, i) => ({
        budgetLineId: lineId,
        householdId,
        monthIndex: i + 1,
        amount,
      })),
    )
    .onConflictDoUpdate({
      target: [budgetAmount.budgetLineId, budgetAmount.monthIndex],
      set: { amount: sql`excluded.amount` },
    });
}

/**
 * Sets the categories whose transactions count as the line's actuals (replace semantics). A
 * category already linked to another line of the same budget (ConflictError, also when a
 * concurrent writer wins the race), the transfer category, and unknown or newly-added archived
 * categories are rejected.
 */
export async function linkCategoriesInTx(
  tx: Tx,
  householdId: string,
  lineId: string,
  categoryIds: string[],
): Promise<void> {
  const ids = [...new Set(parseInput(z.array(z.string()), categoryIds))];
  for (const id of ids) assertUuid(id, 'Category');
  const line = await requireLine(tx, householdId, lineId);

  const current = new Set(
    (
      await tx
        .select({ categoryId: budgetLineCategory.categoryId })
        .from(budgetLineCategory)
        .where(eq(budgetLineCategory.budgetLineId, lineId))
    ).map((r) => r.categoryId),
  );

  if (ids.length > 0) {
    const found = await tx
      .select({
        id: category.id,
        archivedAt: category.archivedAt,
        templateKey: category.templateKey,
      })
      .from(category)
      .where(and(eq(category.householdId, householdId), inArray(category.id, ids)));
    if (found.length !== ids.length) throw new NotFoundError('Category');
    for (const c of found) {
      if (c.templateKey === TRANSFER_CATEGORY_KEY) {
        throw new ValidationError(
          'The transfer category cannot be linked to a budget line',
          [],
          'transfer_category',
        );
      }
      if (c.archivedAt && !current.has(c.id)) throw new ValidationError('Category is archived');
    }
    const clash = await tx
      .select({ categoryId: budgetLineCategory.categoryId })
      .from(budgetLineCategory)
      .where(
        and(
          eq(budgetLineCategory.budgetId, line.budgetId),
          eq(budgetLineCategory.householdId, householdId),
          inArray(budgetLineCategory.categoryId, ids),
          ne(budgetLineCategory.budgetLineId, lineId),
        ),
      );
    if (clash.length > 0) throw linkConflict();
  }

  await tx.delete(budgetLineCategory).where(eq(budgetLineCategory.budgetLineId, lineId));
  if (ids.length > 0) {
    try {
      await tx.insert(budgetLineCategory).values(
        ids.map((categoryId) => ({
          budgetLineId: lineId,
          categoryId,
          budgetId: line.budgetId,
          householdId,
        })),
      );
    } catch (err) {
      // A concurrent writer linked the same category between our check and this insert.
      if (isUniqueViolation(err, LINK_CONSTRAINT)) throw linkConflict();
      throw err;
    }
  }
}

/**
 * Sets the investment buckets (pies) whose invested money counts as the saving line's actuals
 * (replace semantics, duplicates ignored, an empty list clears). A non-empty list needs a saving
 * line on an investment account (`buckets_need_investment_account`) and buckets of that account
 * (NotFoundError otherwise); a bucket already linked to another line of the same budget is a
 * ConflictError, also when a concurrent writer wins the race.
 */
export async function linkBucketsInTx(
  tx: Tx,
  householdId: string,
  lineId: string,
  bucketIds: string[],
): Promise<void> {
  const ids = [...new Set(parseInput(z.array(z.string().uuid()), bucketIds))];
  const line = await requireLine(tx, householdId, lineId);

  if (ids.length > 0) {
    const [account] = line.accountId
      ? await tx
          .select({ type: financialAccount.type })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.id, line.accountId),
              eq(financialAccount.householdId, householdId),
            ),
          )
      : [];
    if (line.kind !== 'saving' || account?.type !== 'investment') {
      throw new ValidationError(
        'Buckets can only be linked to a saving line on an investment account',
        [],
        'buckets_need_investment_account',
      );
    }
    const found = await tx
      .select({ id: investmentBucket.id })
      .from(investmentBucket)
      .where(
        and(
          eq(investmentBucket.householdId, householdId),
          eq(investmentBucket.accountId, line.accountId!),
          inArray(investmentBucket.id, ids),
        ),
      );
    if (found.length !== ids.length) throw new NotFoundError('Bucket');
    const clash = await tx
      .select({ bucketId: budgetLineBucket.bucketId })
      .from(budgetLineBucket)
      .where(
        and(
          eq(budgetLineBucket.budgetId, line.budgetId),
          eq(budgetLineBucket.householdId, householdId),
          inArray(budgetLineBucket.bucketId, ids),
          ne(budgetLineBucket.budgetLineId, lineId),
        ),
      );
    if (clash.length > 0) throw bucketConflict();
  }

  await tx.delete(budgetLineBucket).where(eq(budgetLineBucket.budgetLineId, lineId));
  if (ids.length > 0) {
    try {
      await tx.insert(budgetLineBucket).values(
        ids.map((bucketId) => ({
          budgetLineId: lineId,
          bucketId,
          budgetId: line.budgetId,
          householdId,
        })),
      );
    } catch (err) {
      // A concurrent writer linked the same bucket between our check and this insert.
      if (isUniqueViolation(err, BUCKET_CONSTRAINT)) throw bucketConflict();
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Public CRUD

export async function createBudget(ctx: ServiceCtx, input: CreateBudgetInput): Promise<Budget> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) => createBudgetInTx(tx, ctx, input));
}

export async function listBudgets(ctx: ServiceCtx): Promise<Budget[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(budget)
      .where(eq(budget.householdId, ctx.householdId))
      .orderBy(sql`${budget.startMonth} desc`),
  );
}

async function loadLines(
  tx: Tx,
  householdId: string,
  budgetId: string,
): Promise<BudgetLineDetail[]> {
  const lines = await tx
    .select()
    .from(budgetLine)
    .where(and(eq(budgetLine.budgetId, budgetId), eq(budgetLine.householdId, householdId)))
    .orderBy(asc(budgetLine.position), asc(budgetLine.createdAt), asc(budgetLine.name));
  const lineIds = lines.map((l) => l.id);
  const amounts = lineIds.length
    ? await tx
        .select()
        .from(budgetAmount)
        .where(
          and(
            eq(budgetAmount.householdId, householdId),
            inArray(budgetAmount.budgetLineId, lineIds),
          ),
        )
    : [];
  const links = lineIds.length
    ? await tx
        .select()
        .from(budgetLineCategory)
        .where(
          and(
            eq(budgetLineCategory.budgetId, budgetId),
            eq(budgetLineCategory.householdId, householdId),
          ),
        )
    : [];
  const bucketLinks = lineIds.length
    ? await tx
        .select()
        .from(budgetLineBucket)
        .where(
          and(
            eq(budgetLineBucket.budgetId, budgetId),
            eq(budgetLineBucket.householdId, householdId),
          ),
        )
    : [];
  return lines.map((l) => {
    const planned = Array.from({ length: 12 }, () => 0);
    for (const a of amounts) if (a.budgetLineId === l.id) planned[a.monthIndex - 1] = a.amount;
    return {
      ...l,
      amounts: planned,
      categoryIds: links.filter((k) => k.budgetLineId === l.id).map((k) => k.categoryId),
      bucketIds: bucketLinks.filter((k) => k.budgetLineId === l.id).map((k) => k.bucketId),
    };
  });
}

export async function getBudget(ctx: ServiceCtx, id: string): Promise<BudgetDetail> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const row = await requireBudget(tx, ctx.householdId, id);
    return { ...row, lines: await loadLines(tx, ctx.householdId, id) };
  });
}

export async function upsertBudgetLine(
  ctx: ServiceCtx,
  budgetId: string,
  input: UpsertBudgetLineInput,
): Promise<BudgetLine> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    upsertBudgetLineInTx(tx, ctx.householdId, budgetId, input),
  );
}

export async function deleteBudgetLine(ctx: ServiceCtx, lineId: string): Promise<void> {
  assertCanWrite(ctx);
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireLine(tx, ctx.householdId, lineId);
    await tx
      .delete(budgetLine)
      .where(and(eq(budgetLine.id, lineId), eq(budgetLine.householdId, ctx.householdId)));
  });
}

export async function setLineAmounts(
  ctx: ServiceCtx,
  lineId: string,
  amounts: number[],
): Promise<void> {
  assertCanWrite(ctx);
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    setLineAmountsInTx(tx, ctx.householdId, lineId, amounts),
  );
}

export async function linkCategories(
  ctx: ServiceCtx,
  lineId: string,
  categoryIds: string[],
): Promise<void> {
  assertCanWrite(ctx);
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    linkCategoriesInTx(tx, ctx.householdId, lineId, categoryIds),
  );
}

/**
 * Adds one category to a line's set, keeping the others. The line row is locked while it is read
 * so concurrent adds to one line all land; a category already linked elsewhere in the budget is a
 * ConflictError (`category_already_linked`), and one already on this line is a no-op. Writers only.
 */
export async function addCategoryToLine(
  ctx: ServiceCtx,
  lineId: string,
  categoryId: string,
): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(categoryId, 'Category');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireLine(tx, ctx.householdId, lineId);
    await tx.execute(
      sql`select 1 from budget_line where id = ${lineId}::uuid and household_id = ${ctx.householdId} for update`,
    );
    const current = (
      await tx
        .select({ categoryId: budgetLineCategory.categoryId })
        .from(budgetLineCategory)
        .where(eq(budgetLineCategory.budgetLineId, lineId))
    ).map((r) => r.categoryId);
    if (current.includes(categoryId)) return;
    await linkCategoriesInTx(tx, ctx.householdId, lineId, [...current, categoryId]);
  });
}

/**
 * Saves the line editor in one transaction: the line itself, its 12 amounts and its category links
 * (upsertBudgetLine + setLineAmounts + linkCategories + linkBuckets). Any failure, with the
 * codes of those parts, leaves the budget exactly as it was. Writers only.
 */
export async function saveBudgetLine(
  ctx: ServiceCtx,
  budgetId: string,
  input: SaveBudgetLineInput,
): Promise<BudgetLineDetail> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const line = await upsertBudgetLineInTx(tx, ctx.householdId, budgetId, input.line);
    await setLineAmountsInTx(tx, ctx.householdId, line.id, input.amounts);
    await linkCategoriesInTx(tx, ctx.householdId, line.id, input.categoryIds);
    await linkBucketsInTx(tx, ctx.householdId, line.id, input.bucketIds ?? []);
    // What was stored, not an echo of the input.
    const saved = (await loadLines(tx, ctx.householdId, line.budgetId)).find(
      (l) => l.id === line.id,
    );
    if (!saved) throw new NotFoundError('Budget line');
    return saved;
  });
}

async function setBudgetFields(
  ctx: ServiceCtx,
  id: string,
  set: Partial<Pick<Budget, 'name' | 'status'>>,
): Promise<Budget> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireBudget(tx, ctx.householdId, id);
    const [row] = await tx
      .update(budget)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(budget.id, id), eq(budget.householdId, ctx.householdId)))
      .returning();
    return row!;
  });
}

/** Renames a budget (1..80 characters after trimming). Writers only. */
export async function renameBudget(ctx: ServiceCtx, id: string, name: string): Promise<Budget> {
  assertCanWrite(ctx);
  return setBudgetFields(ctx, id, { name: parseInput(budgetNameSchema, name) });
}

/** Hides a budget from the "current budget" choice; its data is kept. Idempotent. Writers only. */
export async function archiveBudget(ctx: ServiceCtx, id: string): Promise<Budget> {
  assertCanWrite(ctx);
  return setBudgetFields(ctx, id, { status: 'archived' });
}

/** Makes an archived budget active again. Idempotent. Writers only. */
export async function unarchiveBudget(ctx: ServiceCtx, id: string): Promise<Budget> {
  assertCanWrite(ctx);
  return setBudgetFields(ctx, id, { status: 'active' });
}

/** A household without a settings row gets one (defaults) so the choice is never lost. */
async function upsertSettings(
  tx: Tx,
  householdId: string,
  set: Partial<
    Pick<
      typeof householdSettings.$inferInsert,
      'hubAccountId' | 'budgetAlertThresholds' | 'fiscalYearStartMonth'
    >
  >,
): Promise<void> {
  await tx
    .insert(householdSettings)
    .values({ householdId, ...set })
    .onConflictDoUpdate({
      target: householdSettings.householdId,
      set: { ...set, updatedAt: new Date() },
    });
}

/** Sets or clears the household's hub account (the account salary lands in). Owner only. */
export async function setHubAccount(ctx: ServiceCtx, accountId: string | null): Promise<void> {
  assertOwner(ctx);
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    if (accountId !== null) await requireAccount(tx, ctx.householdId, accountId);
    await upsertSettings(tx, ctx.householdId, { hubAccountId: accountId });
  });
}

/**
 * Budget usage percentages that raise an alert: up to 5 unique integers in 1..200, stored
 * ascending; an empty list switches budget alerts off. Owner only.
 */
export async function setBudgetAlertThresholds(
  ctx: ServiceCtx,
  thresholds: number[],
): Promise<void> {
  assertOwner(ctx);
  const sorted = [...parseInput(thresholdsSchema, thresholds)].sort((a, b) => a - b);
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    upsertSettings(tx, ctx.householdId, { budgetAlertThresholds: sorted }),
  );
}

/** The month (1..12) a budget year starts in by default. Owner only. */
export async function setFiscalYearStartMonth(ctx: ServiceCtx, month: number): Promise<void> {
  assertOwner(ctx);
  const fiscalYearStartMonth = parseInput(fiscalMonthSchema, month);
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    upsertSettings(tx, ctx.householdId, { fiscalYearStartMonth }),
  );
}

export type BudgetSettingsInput = {
  fiscalYearStartMonth?: number;
  hubAccountId?: string | null;
  budgetAlertThresholds?: number[];
};

/**
 * Saves the budget settings that are given in one transaction: everything is validated first, so
 * an invalid threshold list (or an unknown hub account) leaves all three settings as they were.
 * Owner only.
 */
export async function updateBudgetSettings(
  ctx: ServiceCtx,
  input: BudgetSettingsInput,
): Promise<void> {
  assertOwner(ctx);
  const set: Parameters<typeof upsertSettings>[2] = {};
  if (input.fiscalYearStartMonth !== undefined) {
    set.fiscalYearStartMonth = parseInput(fiscalMonthSchema, input.fiscalYearStartMonth);
  }
  if (input.budgetAlertThresholds !== undefined) {
    set.budgetAlertThresholds = [...parseInput(thresholdsSchema, input.budgetAlertThresholds)].sort(
      (a, b) => a - b,
    );
  }
  if (input.hubAccountId !== undefined) set.hubAccountId = input.hubAccountId;
  if (Object.keys(set).length === 0) return;
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    if (input.hubAccountId != null) await requireAccount(tx, ctx.householdId, input.hubAccountId);
    await upsertSettings(tx, ctx.householdId, set);
  });
}

/** One budget line with its amounts and categories (read: any role). */
export async function getBudgetLine(ctx: ServiceCtx, id: string): Promise<BudgetLineDetail> {
  assertUuid(id, 'Budget line');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const line = await requireLine(tx, ctx.householdId, id);
    const found = (await loadLines(tx, ctx.householdId, line.budgetId)).find((l) => l.id === id);
    if (!found) throw new NotFoundError('Budget line');
    return found;
  });
}

// ---------------------------------------------------------------------------------------------
// Actuals: one SQL aggregate per view

export type ActualsQueryParams = {
  householdId: string;
  budgetId: string;
  /** Inclusive local dates (household calendar months), `yyyy-mm-dd`. */
  from: string;
  to: string;
  /** Start month of the budget, to turn a purchase date into a month index. */
  startMonth: string;
  currency: string;
  /** The household's transfer category, or null when none was ever seeded. */
  transferCategoryId: string | null;
  /** The household's hub account: saving lines on it receive no account flow. */
  hubAccountId: string | null;
};

type ActualsRow = {
  line_id: string;
  month_index: number;
  status: 'booked' | 'pending';
  cat_sum: string;
  /** Saving lines only: sum of every row on the line's own non-hub account. */
  acct_sum: string;
  foreign_rows: number;
  /** Largest single outflow among the line's category rows (household currency), minor units. */
  max_out: string;
};

/**
 * Grouped sums per (line, month, status) over [from, to]. A row reaches a line two ways:
 * - 'cat': non-transfer rows through the linked categories (a saving line leaves out rows booked
 *   on its own non-hub account: the account rule covers them);
 * - 'acct' (saving lines with a non-hub account): every row booked on that account, whatever its
 *   category and transfer or not, summed signed. The hub account gets none.
 * Transfers are rows with a transfer group or in the transfer category. The first scan is the
 * range scan on (household_id, purchase_date). Every saving line on one account receives the same
 * `acct_sum`; `foldActuals` decides which line, if any, the account's money is traceable to.
 */
export function budgetActualsQuery(p: ActualsQueryParams): SQL {
  const [sy, sm] = p.startMonth.split('-').map(Number) as [number, number];
  const base = sy * 12 + sm;
  return sql`
    with tx as (
      select t.account_id, t.category_id, t.amount, t.currency, t.status, t.transfer_group_id,
        (extract(year from t.purchase_date)::int * 12 + extract(month from t.purchase_date)::int
          - ${base}::int + 1) as month_index
      from "transaction" t
      where t.household_id = ${p.householdId}
        and t.purchase_date between ${p.from}::date and ${p.to}::date
    ), hits as (
      select blc.budget_line_id as line_id, x.month_index, x.status, x.currency, x.amount,
        'cat' as src
      from tx x
      join budget_line_category blc
        on blc.category_id = x.category_id
       and blc.budget_id = ${p.budgetId}::uuid
       and blc.household_id = ${p.householdId}
      join budget_line cl on cl.id = blc.budget_line_id
      where x.transfer_group_id is null
        and x.category_id is distinct from ${p.transferCategoryId}::uuid
        and not (
          cl.kind = 'saving'
          and cl.account_id = x.account_id
          and cl.account_id is distinct from ${p.hubAccountId}::uuid
        )
      union all
      select bl.id, x.month_index, x.status, x.currency, x.amount, 'acct'
      from tx x
      join budget_line bl
        on bl.budget_id = ${p.budgetId}::uuid
       and bl.household_id = ${p.householdId}
       and bl.kind = 'saving'
       and bl.account_id = x.account_id
       and bl.account_id is distinct from ${p.hubAccountId}::uuid
    )
    select line_id, month_index, status,
      coalesce(sum(amount) filter (where currency = ${p.currency} and src = 'cat'), 0)::text
        as cat_sum,
      coalesce(sum(amount) filter (where currency = ${p.currency} and src = 'acct'), 0)::text
        as acct_sum,
      (count(*) filter (where currency <> ${p.currency}))::int as foreign_rows,
      coalesce(greatest(max(-amount) filter (where currency = ${p.currency} and src = 'cat'), 0), 0)::text
        as max_out
    from hits
    group by line_id, month_index, status`;
}

export type Cell = { planned: number; actual: number; pending: number };

type LineActuals = {
  actual: number;
  pending: number;
  foreignCurrencyRows: number;
  largestRow: number;
  /** A bucket line whose month cannot be known (no baseline snapshot, or a null amount). */
  noData: boolean;
  /** Current month only: the end snapshot day when it is more than 3 days old, else null. */
  staleAsOf: string | null;
};

const emptyActuals = (): LineActuals => ({
  actual: 0,
  pending: 0,
  foreignCurrencyRows: 0,
  largestRow: 0,
  noData: false,
  staleAsOf: null,
});

/** A snapshot older than this many days (before today) is shown with a "data from" note. */
const STALE_AFTER_DAYS = 3;

type Folded = {
  /** Key `line:month`. */
  actuals: Map<string, LineActuals>;
  /** Key `account:month`: booked account money not traceable to a line (non-zero only). */
  unassigned: Map<string, number>;
};

/**
 * Key `line:month` -> display-signed actuals (expense = -sum, income = sum, saving = see below),
 * plus the saving money no line can claim. A saving line counts only money traceable to it; the
 * rest is reported as unassigned, never split between lines.
 *
 * Saving lines with a non-hub account are grouped by account and classified: `buckets` when
 * they have linked buckets, else `account`.
 * - A lone `account` line on its account gets the account's sum of all rows (booked -> actual,
 *   pending -> pending), on top of its categories on other accounts.
 * - Otherwise every `account` line gets 0 from the account, and the booked residual (account sum
 *   minus the known bucket deltas of the group) is the account's unassigned amount.
 * - A `buckets` line gets its buckets' invested delta as actual (pending adds 0) plus its categories
 *   on other accounts; with no baseline the month is unknown: actual 0 and `noData`.
 * The hub account never receives account flow, so it is never grouped.
 *
 * `deltas` holds the `investedDelta` per `line:month` of the bucket lines.
 */
function foldActuals(
  rows: ActualsRow[],
  lines: BudgetLineDetail[],
  hubAccountId: string | null,
  deltas: ReadonlyMap<string, InvestedDelta>,
  months: readonly BudgetMonth[],
  today: string,
): Folded {
  const kindOf = new Map(lines.map((l) => [l.id, l.kind]));
  const out = new Map<string, LineActuals>();
  const entry = (line: string, month: number): LineActuals => {
    const key = `${line}:${month}`;
    let cur = out.get(key);
    if (!cur) {
      cur = emptyActuals();
      out.set(key, cur);
    }
    return cur;
  };
  const acct = new Map<string, number>(); // `account:month:status` -> sum of all its rows
  const accountOf = new Map(lines.map((l) => [l.id, l.accountId]));

  for (const r of rows) {
    const kind = kindOf.get(r.line_id);
    if (!kind) continue;
    const cur = entry(r.line_id, r.month_index);
    const cat = toSafeNumber(r.cat_sum);
    const value = kind === 'income' ? cat : -cat;
    if (r.status === 'booked') cur.actual += value;
    else cur.pending += value;
    cur.foreignCurrencyRows += r.foreign_rows;
    if (r.status === 'booked') cur.largestRow = Math.max(cur.largestRow, toSafeNumber(r.max_out));
    const account = accountOf.get(r.line_id);
    if (kind === 'saving' && account)
      acct.set(`${account}:${r.month_index}:${r.status}`, toSafeNumber(r.acct_sum));
  }

  const byAccount = new Map<string, BudgetLineDetail[]>();
  for (const l of lines) {
    if (l.kind !== 'saving' || !l.accountId || l.accountId === hubAccountId) continue;
    byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);
  }
  const unassigned = new Map<string, number>();
  const current = months.find((m) => m.from <= today && today <= m.to)?.index;
  const staleBefore = shiftDay(today, STALE_AFTER_DAYS);
  for (const [accountId, group] of byAccount) {
    const bucketLines = group.filter((l) => l.bucketIds.length > 0);
    const accountLines = group.filter((l) => l.bucketIds.length === 0);
    for (let month = 1; month <= 12; month++) {
      const booked = acct.get(`${accountId}:${month}:booked`) ?? 0;
      const pending = acct.get(`${accountId}:${month}:pending`) ?? 0;
      let tracedByBuckets = 0;
      for (const l of bucketLines) {
        const cur = entry(l.id, month);
        const d = deltas.get(`${l.id}:${month}`);
        if (!d || d.kind === 'noData') {
          cur.actual = 0; // the month is unknown: not even its categories are shown
          cur.noData = true;
          continue;
        }
        cur.actual += d.delta;
        cur.foreignCurrencyRows += d.foreignRows;
        tracedByBuckets += d.delta;
        if (month === current && d.endAsOf !== null && d.endAsOf < staleBefore)
          cur.staleAsOf = d.endAsOf;
      }
      if (group.length === 1 && accountLines.length === 1) {
        const cur = entry(accountLines[0]!.id, month);
        cur.actual += booked;
        cur.pending += pending;
      } else {
        const residual = booked - tracedByBuckets;
        if (residual !== 0) unassigned.set(`${accountId}:${month}`, residual);
      }
    }
  }
  return { actuals: out, unassigned };
}

type ViewBase = {
  budget: Budget;
  lines: BudgetLineDetail[];
  currency: string;
  timezone: string;
  hubAccountId: string | null;
  months: BudgetMonth[];
  transferCategoryId: string | null;
};

async function loadViewBase(
  tx: Tx,
  ctx: Pick<ServiceCtx, 'householdId'>,
  budgetId: string,
): Promise<ViewBase> {
  const row = await requireBudget(tx, ctx.householdId, budgetId);
  const [settings] = await tx
    .select({
      currency: householdSettings.currency,
      timezone: householdSettings.timezone,
      hubAccountId: householdSettings.hubAccountId,
    })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, ctx.householdId));
  if (!settings) throw new NotFoundError('Household settings');
  if (!isValidTimezone(settings.timezone)) {
    throw new ValidationError(
      `Unknown household timezone: ${settings.timezone}`,
      [],
      'invalid_timezone',
    );
  }
  return {
    budget: row,
    lines: await loadLines(tx, ctx.householdId, budgetId),
    currency: settings.currency,
    timezone: settings.timezone,
    hubAccountId: settings.hubAccountId,
    months: budgetMonths(row.startMonth, settings.timezone),
    transferCategoryId: (await findTransferCategory(tx, ctx.householdId)) ?? null,
  };
}

async function runActuals(
  tx: Tx,
  ctx: Pick<ServiceCtx, 'householdId'>,
  base: ViewBase,
  from: string,
  to: string,
): Promise<Folded> {
  const res = await tx.execute<ActualsRow>(
    budgetActualsQuery({
      householdId: ctx.householdId,
      budgetId: base.budget.id,
      from,
      to,
      startMonth: base.budget.startMonth,
      currency: base.currency,
      transferCategoryId: base.transferCategoryId,
      hubAccountId: base.hubAccountId,
    }),
  );
  const today = todayInZone(base.timezone);
  const deltas = await loadInvestedDeltas(tx, ctx.householdId, base, today);
  return foldActuals(
    res.rows ?? (res as unknown as ActualsRow[]),
    base.lines,
    base.hubAccountId,
    deltas,
    base.months,
    today,
  );
}

/** How far before the budget's start a baseline snapshot may be. */
const BASELINE_LOOKBACK_DAYS = 40;

/** A pie first snapshotted within this many days after the month start still has a baseline. */
const BUCKET_BASELINE_GRACE_DAYS = 2;

/** `investedDelta` per `line:month` for every saving line (non-hub account) with buckets. */
async function loadInvestedDeltas(
  tx: Tx,
  householdId: string,
  base: ViewBase,
  today: string,
): Promise<Map<string, InvestedDelta>> {
  const linked = new Map<string, Set<string>>();
  const bucketLines = base.lines.filter(
    (l) =>
      l.kind === 'saving' &&
      l.accountId !== null &&
      l.accountId !== base.hubAccountId &&
      l.bucketIds.length > 0,
  );
  for (const l of bucketLines) {
    const set = linked.get(l.accountId!) ?? new Set<string>();
    for (const bucketId of l.bucketIds) set.add(bucketId);
    linked.set(l.accountId!, set);
  }
  const days = await loadSnapshotDays(tx, householdId, linked, {
    from: shiftDay(base.months[0]!.from, BASELINE_LOOKBACK_DAYS),
    to: base.months[11]!.to,
  });
  const out = new Map<string, InvestedDelta>();
  for (const l of bucketLines) {
    for (const m of base.months) {
      out.set(
        `${l.id}:${m.index}`,
        investedDelta(
          days.get(l.accountId!) ?? [],
          l.bucketIds,
          { from: m.from, to: m.to, today },
          base.currency,
          { baselineGraceDays: BUCKET_BASELINE_GRACE_DAYS },
        ),
      );
    }
  }
  return out;
}

/**
 * Net booked flow (inflows minus outflows, every row: transfers or not, household currency) per
 * calendar month of [from, to], keyed `yyyy-mm`, on the accounts linked to saving lines, with the
 * hub exclusion of `budgetActualsQuery`. Card spending on such an account therefore nets against
 * the money moved in. An account counts once per month however many saving lines or budgets
 * cover it, and only for months inside the year of an active (non-archived) budget that has such
 * a line, as in the budget alerts. Account level: buckets are not used. No budget means an
 * empty map.
 */
export async function savingFlowByMonthInTx(
  tx: Tx,
  p: {
    householdId: string;
    from: string;
    to: string;
    currency: string;
    hubAccountId: string | null;
  },
): Promise<Map<string, number>> {
  const res = await tx.execute<{ month: string; flow: string }>(sql`
    select to_char(t.purchase_date, 'YYYY-MM') as month, coalesce(sum(t.amount), 0)::text as flow
    from "transaction" t
    where t.household_id = ${p.householdId}
      and t.status = 'booked'
      and t.currency = ${p.currency}
      and t.purchase_date between ${p.from}::date and ${p.to}::date
      and exists (
        select 1
        from budget_line bl
        join budget b on b.id = bl.budget_id and b.household_id = bl.household_id
        where bl.household_id = ${p.householdId}
          and b.status = 'active'
          and bl.kind = 'saving'
          and bl.account_id = t.account_id
          and bl.account_id is distinct from ${p.hubAccountId}::uuid
          and date_trunc('month', t.purchase_date) >= b.start_month
          and date_trunc('month', t.purchase_date) < b.start_month + interval '12 months'
      )
    group by 1`);
  const rows = res.rows ?? (res as unknown as Array<{ month: string; flow: string }>);
  return new Map(rows.map((r) => [r.month, toSafeNumber(r.flow)]));
}

const zeroCell = (): Cell => ({ planned: 0, actual: 0, pending: 0 });
function addCell(into: Cell, c: Cell): void {
  into.planned += c.planned;
  into.actual += c.actual;
  into.pending += c.pending;
}

export type LineView = {
  lineId: string;
  kind: BudgetKind;
  name: string;
  groupId: string | null;
  accountId: string | null;
  planned: number;
  /** Booked, household currency. Expense: spending net of refunds; income: received. */
  actual: number;
  /** Same formula over pending rows; never part of `actual`. */
  pending: number;
  /** planned - actual (may be negative). */
  remaining: number;
  /** Rounded actual / planned in percent; null when nothing is planned. */
  percent: number | null;
  foreignCurrencyRows: number;
  /** Largest single booked outflow among the line's category rows, household currency. */
  largestRow: number;
  /** Bucket line, month unknown (no baseline snapshot): `actual` is 0, not "nothing saved". */
  noData: boolean;
  /** Current month of a bucket line: the end snapshot day when it is over 3 days old. */
  staleAsOf: string | null;
};
export type GroupView = { kind: BudgetKind; groupId: string | null } & Cell;
export type BudgetMonthView = {
  budgetId: string;
  monthIndex: number;
  from: string;
  to: string;
  currency: string;
  lines: LineView[];
  groups: GroupView[];
  totals: Record<BudgetKind, Cell>;
  /** income - expense - saving. */
  unallocated: { planned: number; actual: number };
  /**
   * Booked money on a saving line's account that no line can claim (several lines share the
   * account, or part of it is not in the linked buckets). Non-zero only, never the hub, and
   * not part of `totals`.
   */
  unassignedSavings: Array<{ accountId: string; accountName: string; actual: number }>;
};

export async function budgetMonthView(
  ctx: ServiceCtx,
  budgetId: string,
  rawMonthIndex: number,
): Promise<BudgetMonthView> {
  const monthIndex = parseInput(monthIndexSchema, rawMonthIndex);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const base = await loadViewBase(tx, ctx, budgetId);
    const month = base.months[monthIndex - 1]!;
    const { actuals, unassigned } = await runActuals(tx, ctx, base, month.from, month.to);

    const totals: Record<BudgetKind, Cell> = {
      income: zeroCell(),
      expense: zeroCell(),
      saving: zeroCell(),
    };
    const groups = new Map<string, GroupView>();
    const lines = base.lines.map((l): LineView => {
      const planned = l.amounts[monthIndex - 1]!;
      const a = actuals.get(`${l.id}:${monthIndex}`) ?? emptyActuals();
      const cell = { planned, actual: a.actual, pending: a.pending };
      addCell(totals[l.kind], cell);
      const gKey = `${l.kind}:${l.groupId ?? ''}`;
      const g = groups.get(gKey) ?? { kind: l.kind, groupId: l.groupId, ...zeroCell() };
      addCell(g, cell);
      groups.set(gKey, g);
      return {
        lineId: l.id,
        kind: l.kind,
        name: l.name,
        groupId: l.groupId,
        accountId: l.accountId,
        planned,
        actual: a.actual,
        pending: a.pending,
        remaining: planned - a.actual,
        percent: planned > 0 ? Math.round((a.actual * 100) / planned) : null,
        foreignCurrencyRows: a.foreignCurrencyRows,
        largestRow: a.largestRow,
        noData: a.noData,
        staleAsOf: a.staleAsOf,
      };
    });
    const unassignedIds = [...unassigned.keys()]
      .filter((k) => k.endsWith(`:${monthIndex}`))
      .map((k) => k.slice(0, k.length - `:${monthIndex}`.length));
    const names = unassignedIds.length
      ? await tx
          .select({ id: financialAccount.id, name: financialAccount.name })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.householdId, ctx.householdId),
              inArray(financialAccount.id, unassignedIds),
            ),
          )
      : [];
    const unassignedSavings = names
      .map((n) => ({
        accountId: n.id,
        accountName: n.name,
        actual: unassigned.get(`${n.id}:${monthIndex}`)!,
      }))
      .sort((x, y) => x.accountName.localeCompare(y.accountName));
    return {
      unassignedSavings,
      budgetId,
      monthIndex,
      from: month.from,
      to: month.to,
      currency: base.currency,
      lines,
      groups: [...groups.values()],
      totals,
      unallocated: {
        planned: totals.income.planned - totals.expense.planned - totals.saving.planned,
        actual: totals.income.actual - totals.expense.actual - totals.saving.actual,
      },
    };
  });
}

export type YearCell = Cell & { index: number; noData: boolean };
export type YearCells = { months: YearCell[]; total: Cell };
export type YearLine = YearCells & {
  lineId: string;
  kind: BudgetKind;
  name: string;
  groupId: string | null;
  accountId: string | null;
  foreignCurrencyRows: number;
};
export type BudgetYearView = {
  budgetId: string;
  currency: string;
  months: BudgetMonth[];
  lines: YearLine[];
  totals: Record<BudgetKind, YearCells>;
  unallocated: {
    months: Array<{ index: number; planned: number; actual: number }>;
    planned: number;
    actual: number;
  };
};

export async function budgetYearView(ctx: ServiceCtx, budgetId: string): Promise<BudgetYearView> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    budgetYearViewInTx(tx, ctx.householdId, budgetId),
  );
}

/** budgetYearView inside a transaction. No role check. */
export async function budgetYearViewInTx(
  tx: Tx,
  householdId: string,
  budgetId: string,
): Promise<BudgetYearView> {
  const ctx = { householdId };
  const base = await loadViewBase(tx, ctx, budgetId);
  const { actuals } = await runActuals(tx, ctx, base, base.months[0]!.from, base.months[11]!.to);

  const emptyCells = (): YearCells => ({
    months: base.months.map((m) => ({ index: m.index, noData: false, ...zeroCell() })),
    total: zeroCell(),
  });
  const totals: Record<BudgetKind, YearCells> = {
    income: emptyCells(),
    expense: emptyCells(),
    saving: emptyCells(),
  };
  const lines = base.lines.map((l): YearLine => {
    const cells = emptyCells();
    let foreignCurrencyRows = 0;
    for (const m of base.months) {
      const a = actuals.get(`${l.id}:${m.index}`);
      const cell = {
        planned: l.amounts[m.index - 1]!,
        actual: a?.actual ?? 0,
        pending: a?.pending ?? 0,
      };
      foreignCurrencyRows += a?.foreignCurrencyRows ?? 0;
      addCell(cells.months[m.index - 1]!, cell);
      cells.months[m.index - 1]!.noData = a?.noData ?? false;
      addCell(cells.total, cell);
      addCell(totals[l.kind].months[m.index - 1]!, cell);
      addCell(totals[l.kind].total, cell);
    }
    return {
      lineId: l.id,
      kind: l.kind,
      name: l.name,
      groupId: l.groupId,
      accountId: l.accountId,
      foreignCurrencyRows,
      ...cells,
    };
  });
  const months = base.months.map((m) => {
    const i = m.index - 1;
    return {
      index: m.index,
      planned:
        totals.income.months[i]!.planned -
        totals.expense.months[i]!.planned -
        totals.saving.months[i]!.planned,
      actual:
        totals.income.months[i]!.actual -
        totals.expense.months[i]!.actual -
        totals.saving.months[i]!.actual,
    };
  });
  return {
    budgetId,
    currency: base.currency,
    months: base.months,
    lines,
    totals,
    unallocated: {
      months,
      planned: months.reduce((s, m) => s + m.planned, 0),
      actual: months.reduce((s, m) => s + m.actual, 0),
    },
  };
}

export type UnbudgetedRow = {
  categoryId: string | null;
  categoryName: string | null;
  actual: number;
  pending: number;
  foreignCurrencyRows: number;
};

/**
 * Spending in the month that no budget line covers: expense-kind categories with no link in this
 * budget, plus uncategorised outflows (uncategorised inflows are not assumed to be refunds).
 * Largest first.
 */
export async function unbudgetedSpending(
  ctx: ServiceCtx,
  budgetId: string,
  rawMonthIndex: number,
): Promise<UnbudgetedRow[]> {
  const monthIndex = parseInput(monthIndexSchema, rawMonthIndex);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const base = await loadViewBase(tx, ctx, budgetId);
    const month = base.months[monthIndex - 1]!;
    const res = await tx.execute<{
      category_id: string | null;
      category_name: string | null;
      actual: string;
      pending: string;
      foreign_rows: number;
    }>(sql`
      select x.category_id, c.name as category_name,
        coalesce(-sum(x.amount) filter (where x.status = 'booked' and x.currency = ${base.currency}), 0)::text as actual,
        coalesce(-sum(x.amount) filter (where x.status = 'pending' and x.currency = ${base.currency}), 0)::text as pending,
        (count(*) filter (where x.currency <> ${base.currency}))::int as foreign_rows
      from "transaction" x
      left join category c on c.id = x.category_id and c.household_id = x.household_id
      left join category_group g on g.id = c.group_id and g.household_id = c.household_id
      where x.household_id = ${ctx.householdId}
        and x.purchase_date between ${month.from}::date and ${month.to}::date
        and x.transfer_group_id is null
        and x.category_id is distinct from ${base.transferCategoryId}::uuid
        and not exists (
          select 1 from budget_line_category blc
          where blc.budget_id = ${budgetId}::uuid and blc.category_id = x.category_id
        )
        and ((x.category_id is null and x.amount < 0) or g.kind = 'expense')
      group by x.category_id, c.name`);
    const rows = res.rows ?? (res as unknown as never[]);
    return rows
      .map((r) => ({
        categoryId: r.category_id,
        categoryName: r.category_name,
        actual: toSafeNumber(r.actual),
        pending: toSafeNumber(r.pending),
        foreignCurrencyRows: r.foreign_rows,
      }))
      .filter((r) => r.actual !== 0 || r.pending !== 0 || r.foreignCurrencyRows > 0)
      .sort(
        (a, b) => b.actual - a.actual || (a.categoryName ?? '').localeCompare(b.categoryName ?? ''),
      );
  });
}

export type TransferPlanView =
  | { configured: false }
  | ({ configured: true; hubAccountId: string; monthIndex: number } & TransferPlan);

/** What to move out of the hub for the month's planned expenses and savings. */
export async function transferPlan(
  ctx: ServiceCtx,
  budgetId: string,
  rawMonthIndex: number,
): Promise<TransferPlanView> {
  const monthIndex = parseInput(monthIndexSchema, rawMonthIndex);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireBudget(tx, ctx.householdId, budgetId);
    const [settings] = await tx
      .select({ hubAccountId: householdSettings.hubAccountId })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    const hubAccountId = settings?.hubAccountId ?? null;
    if (hubAccountId === null) return { configured: false };
    const lines = await loadLines(tx, ctx.householdId, budgetId);
    const plan = computeTransferPlan({
      hubAccountId,
      lines: lines.map((l) => ({
        kind: l.kind,
        accountId: l.accountId,
        planned: l.amounts[monthIndex - 1]!,
      })),
    });
    return { configured: true, hubAccountId, monthIndex, ...plan };
  });
}
