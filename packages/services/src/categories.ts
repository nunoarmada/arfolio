import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { TRANSFER_CATEGORY_KEY } from './category-templates.js';

const { category, categoryGroup, merchant, rule, transaction } = schema;

export type CategoryGroup = typeof categoryGroup.$inferSelect;
export type Category = typeof category.$inferSelect;
export type CategoryGroupWithCategories = CategoryGroup & { categories: Category[] };

/** The transfer group is system-managed (seeded once per household); callers cannot create or convert to it. */
const USER_GROUP_KINDS = ['income', 'expense', 'saving'] as const;

const sortField = z.number().int().min(0).max(32_767);
const nameField = z.string().trim().min(1).max(80);

const createGroupSchema = z.strictObject({
  name: nameField,
  kind: z.enum(USER_GROUP_KINDS),
  sort: sortField.optional(),
});
const updateGroupSchema = z.strictObject({
  name: nameField.optional(),
  kind: z.enum(USER_GROUP_KINDS).optional(),
  sort: sortField.optional(),
});
const createCategorySchema = z.strictObject({
  groupId: z.string(),
  name: nameField,
  icon: z.string().trim().min(1).max(40).nullable().optional(),
  sort: sortField.optional(),
});
const updateCategorySchema = z.strictObject({
  groupId: z.string().optional(),
  name: nameField.optional(),
  icon: z.string().trim().min(1).max(40).nullable().optional(),
  sort: sortField.optional(),
});

export type CreateCategoryGroupInput = z.input<typeof createGroupSchema>;
export type UpdateCategoryGroupPatch = z.input<typeof updateGroupSchema>;
export type CreateCategoryInput = z.input<typeof createCategorySchema>;
export type UpdateCategoryPatch = z.input<typeof updateCategorySchema>;

export async function listCategories(
  ctx: ServiceCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<CategoryGroupWithCategories[]> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const groups = await tx
      .select()
      .from(categoryGroup)
      .where(
        and(
          eq(categoryGroup.householdId, ctx.householdId),
          opts.includeArchived ? undefined : isNull(categoryGroup.archivedAt),
        ),
      )
      .orderBy(categoryGroup.sort, categoryGroup.name, categoryGroup.id);
    const categories = await tx
      .select()
      .from(category)
      .where(
        and(
          eq(category.householdId, ctx.householdId),
          opts.includeArchived ? undefined : isNull(category.archivedAt),
        ),
      )
      .orderBy(category.sort, category.name, category.id);
    return groups.map((g) => ({ ...g, categories: categories.filter((c) => c.groupId === g.id) }));
  });
}

async function requireGroup(
  tx: Tx,
  ctx: Pick<ServiceCtx, 'householdId'>,
  id: string,
): Promise<CategoryGroup> {
  assertUuid(id, 'Category group');
  const [row] = await tx
    .select()
    .from(categoryGroup)
    .where(and(eq(categoryGroup.id, id), eq(categoryGroup.householdId, ctx.householdId)));
  if (!row) throw new NotFoundError('Category group');
  return row;
}

/** A group callers may add categories to: the system-managed transfer group is closed to them. */
async function requireOpenGroup(
  tx: Tx,
  ctx: Pick<ServiceCtx, 'householdId'>,
  id: string,
): Promise<CategoryGroup> {
  const group = await requireGroup(tx, ctx, id);
  if (group.kind === 'transfer') {
    throw new ValidationError('The transfer group cannot hold other categories');
  }
  return group;
}

async function requireCategory(tx: Tx, ctx: ServiceCtx, id: string): Promise<Category> {
  assertUuid(id, 'Category');
  const [row] = await tx
    .select()
    .from(category)
    .where(and(eq(category.id, id), eq(category.householdId, ctx.householdId)));
  if (!row) throw new NotFoundError('Category');
  return row;
}

/** Creates a category group (no role check). */
export async function createCategoryGroupInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateCategoryGroupInput,
): Promise<CategoryGroup> {
  const input = parseInput(createGroupSchema, rawInput);
  const [row] = await tx
    .insert(categoryGroup)
    .values({ ...input, householdId })
    .returning();
  return row!;
}

export async function createCategoryGroup(
  ctx: ServiceCtx,
  rawInput: CreateCategoryGroupInput,
): Promise<CategoryGroup> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createCategoryGroupInTx(tx, ctx.householdId, rawInput),
  );
}

export async function updateCategoryGroup(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateCategoryGroupPatch,
): Promise<CategoryGroup> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category group');
  const patch = parseInput(updateGroupSchema, rawPatch);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const current = await requireGroup(tx, ctx, id);
    if (current.kind === 'transfer' && patch.kind !== undefined) {
      throw new ValidationError('The transfer group cannot change kind');
    }
    if (Object.keys(patch).length === 0) return current;
    const [row] = await tx
      .update(categoryGroup)
      .set(patch)
      .where(eq(categoryGroup.id, id))
      .returning();
    return row!;
  });
}

/** Archives the group together with its categories. Transactions keep their categories. */
export async function archiveCategoryGroup(ctx: ServiceCtx, id: string): Promise<CategoryGroup> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category group');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireGroup(tx, ctx, id);
    await tx
      .update(category)
      .set({ archivedAt: sql`coalesce(${category.archivedAt}, now())` })
      .where(and(eq(category.groupId, id), eq(category.householdId, ctx.householdId)));
    const [row] = await tx
      .update(categoryGroup)
      .set({ archivedAt: sql`coalesce(${categoryGroup.archivedAt}, now())` })
      .where(eq(categoryGroup.id, id))
      .returning();
    return row!;
  });
}

/** Deletes an empty, user-created group. Template groups and groups with categories: archive. */
export async function deleteCategoryGroup(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category group');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const group = await requireGroup(tx, ctx, id);
    if (group.templateKey) {
      throw new ValidationError('Template groups cannot be deleted, archive them instead');
    }
    const [child] = await tx
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.groupId, id), eq(category.householdId, ctx.householdId)))
      .limit(1);
    if (child) {
      throw new ValidationError('The group still has categories: delete or archive them first');
    }
    await tx.delete(categoryGroup).where(eq(categoryGroup.id, id));
  });
}

/** Creates a category in an open (non-transfer) group of the household (no role check). */
export async function createCategoryInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateCategoryInput,
): Promise<Category> {
  const input = parseInput(createCategorySchema, rawInput);
  await requireOpenGroup(tx, { householdId }, input.groupId);
  const [row] = await tx
    .insert(category)
    .values({ ...input, householdId })
    .returning();
  return row!;
}

export async function createCategory(
  ctx: ServiceCtx,
  rawInput: CreateCategoryInput,
): Promise<Category> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createCategoryInTx(tx, ctx.householdId, rawInput),
  );
}

export async function updateCategory(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateCategoryPatch,
): Promise<Category> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category');
  const patch = parseInput(updateCategorySchema, rawPatch);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const current = await requireCategory(tx, ctx, id);
    if (patch.groupId && patch.groupId !== current.groupId) {
      const [from] = await tx
        .select({ kind: categoryGroup.kind })
        .from(categoryGroup)
        .where(eq(categoryGroup.id, current.groupId));
      if (from?.kind === 'transfer' || current.templateKey === TRANSFER_CATEGORY_KEY) {
        throw new ValidationError('The transfer category cannot be moved');
      }
      await requireOpenGroup(tx, ctx, patch.groupId);
    }
    if (Object.keys(patch).length === 0) return current;
    const [row] = await tx.update(category).set(patch).where(eq(category.id, id)).returning();
    return row!;
  });
}

export async function archiveCategory(ctx: ServiceCtx, id: string): Promise<Category> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireCategory(tx, ctx, id);
    const [row] = await tx
      .update(category)
      .set({ archivedAt: sql`coalesce(${category.archivedAt}, now())` })
      .where(eq(category.id, id))
      .returning();
    return row!;
  });
}

/**
 * Deletes a user-created category. Foreign keys block deleting a referenced category, so its
 * references are moved first: to `reassignTo` when given; otherwise transactions return to the
 * review inbox (uncategorised, needs review), merchant memories are cleared and rules for the
 * category are deleted. Template categories can only be archived. With `reassignTo`, budget
 * links move to the target too (not into a budget that already links it), and the transfer
 * category is not a valid target.
 */
export async function deleteCategory(
  ctx: ServiceCtx,
  id: string,
  opts: { reassignTo?: string } = {},
): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Category');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const current = await requireCategory(tx, ctx, id);
    if (current.templateKey) {
      throw new ValidationError('Template categories cannot be deleted, archive them instead');
    }
    const target = opts.reassignTo;
    if (target !== undefined) {
      if (target === id) throw new ValidationError('Cannot reassign a category to itself');
      const to = await requireCategory(tx, ctx, target);
      // A transfer row is never income or expense: reassigning into it would hide the rows.
      if (to.templateKey === TRANSFER_CATEGORY_KEY) {
        throw new ValidationError('Cannot reassign a category to the transfer category');
      }
      // Rows keep their meaning (spending stays spending, income stays income).
      const kinds = await tx
        .select({ id: category.id, kind: categoryGroup.kind })
        .from(category)
        .innerJoin(
          categoryGroup,
          and(
            eq(categoryGroup.id, category.groupId),
            eq(categoryGroup.householdId, category.householdId),
          ),
        )
        .where(and(inArray(category.id, [id, target]), eq(category.householdId, ctx.householdId)));
      if (new Set(kinds.map((k) => k.kind)).size > 1) {
        throw new ValidationError('Reassign into a category of the same kind');
      }
    }
    if (target !== undefined) {
      // Budget links follow the rows to the target, except in a budget where the target is
      // linked already (one category per budget); those links go with the category.
      await tx.execute(sql`
        update budget_line_category blc set category_id = ${target}::uuid
        where blc.household_id = ${ctx.householdId} and blc.category_id = ${id}::uuid
          and not exists (
            select 1 from budget_line_category t
            where t.household_id = blc.household_id and t.budget_id = blc.budget_id
              and t.category_id = ${target}::uuid
          )`);
      await tx
        .update(transaction)
        .set({ categoryId: target })
        .where(and(eq(transaction.categoryId, id), eq(transaction.householdId, ctx.householdId)));
      await tx
        .update(rule)
        .set({ categoryId: target })
        .where(and(eq(rule.categoryId, id), eq(rule.householdId, ctx.householdId)));
    } else {
      await tx
        .update(transaction)
        .set({
          categoryId: null,
          categorisedBy: null,
          confidence: null,
          needsReview: true,
          // Rows the person never edited go back to the AI for a fresh set of attempts.
          aiAttempts: sql`case when ${transaction.userEditedAt} is null then 0 else ${transaction.aiAttempts} end`,
          aiConfidence: sql`case when ${transaction.userEditedAt} is null then null else ${transaction.aiConfidence} end`,
        })
        .where(and(eq(transaction.categoryId, id), eq(transaction.householdId, ctx.householdId)));
      await tx
        .delete(rule)
        .where(and(eq(rule.categoryId, id), eq(rule.householdId, ctx.householdId)));
    }
    // AI suggestions pointing at the category would block the delete (FK, no action).
    await tx
      .update(transaction)
      .set({ aiSuggestedCategoryId: null, aiConfidence: null })
      .where(
        and(
          eq(transaction.aiSuggestedCategoryId, id),
          eq(transaction.householdId, ctx.householdId),
        ),
      );
    await tx
      .update(merchant)
      .set({ defaultCategoryId: target ?? null })
      .where(and(eq(merchant.defaultCategoryId, id), eq(merchant.householdId, ctx.householdId)));
    await tx
      .delete(category)
      .where(and(eq(category.id, id), eq(category.householdId, ctx.householdId)));
  });
}

/** Saves a new order for category groups: every active group except the transfer group once, in display order (max 500), in one transaction. */
export async function reorderCategoryGroups(ctx: ServiceCtx, ids: string[]): Promise<void> {
  assertCanWrite(ctx);
  const list = parseInput(z.array(z.uuid()).min(1).max(500), ids);
  if (new Set(list).size !== list.length) throw new ValidationError('Duplicate ids in the order');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const siblings = await tx
      .select({ id: categoryGroup.id })
      .from(categoryGroup)
      .where(
        and(
          eq(categoryGroup.householdId, ctx.householdId),
          isNull(categoryGroup.archivedAt),
          ne(categoryGroup.kind, 'transfer'),
        ),
      );
    if (siblings.length !== list.length || !siblings.every((g) => list.includes(g.id))) {
      throw new ValidationError('The order must list every active group exactly once');
    }
    for (const [index, id] of list.entries()) {
      await tx
        .update(categoryGroup)
        .set({ sort: index * 10 })
        .where(and(eq(categoryGroup.id, id), eq(categoryGroup.householdId, ctx.householdId)));
    }
    // The transfer group is not orderable: it stays after every other group.
    await tx
      .update(categoryGroup)
      .set({ sort: (list.length + 1) * 10 })
      .where(
        and(eq(categoryGroup.householdId, ctx.householdId), eq(categoryGroup.kind, 'transfer')),
      );
  });
}

/** Saves a new order for the categories of one group: `ids` in display order (1 to 500). */
export async function reorderCategories(ctx: ServiceCtx, ids: string[]): Promise<void> {
  assertCanWrite(ctx);
  const list = parseInput(z.array(z.uuid()).min(1).max(500), ids);
  if (new Set(list).size !== list.length) throw new ValidationError('Duplicate ids in the order');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const found = await tx
      .select({ id: category.id, groupId: category.groupId })
      .from(category)
      .where(and(eq(category.householdId, ctx.householdId), inArray(category.id, list)));
    if (found.length !== list.length) throw new NotFoundError('Category');
    if (new Set(found.map((c) => c.groupId)).size > 1) {
      throw new ValidationError('The categories must belong to one group');
    }
    const siblings = await tx
      .select({ id: category.id })
      .from(category)
      .where(
        and(
          eq(category.householdId, ctx.householdId),
          eq(category.groupId, found[0]!.groupId),
          isNull(category.archivedAt),
        ),
      );
    if (siblings.length !== list.length || !siblings.every((c) => list.includes(c.id))) {
      throw new ValidationError(
        'The order must list every active category of the group exactly once',
      );
    }
    for (const [index, id] of list.entries()) {
      await tx
        .update(category)
        .set({ sort: index * 10 })
        .where(and(eq(category.id, id), eq(category.householdId, ctx.householdId)));
    }
  });
}
