import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  matchRule,
  merchantKey,
  validateWildcardPattern,
  type Rule as CoreRule,
} from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { recordAudit } from './audit.js';
import { TRANSFER_CATEGORY_KEY } from './category-templates.js';
import {
  assertCanWrite,
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type WriteOpts,
  type ServiceCtx,
} from './context.js';

const { category, categoryGroup, merchant, rule, transaction, undoToken } = schema;

export type RuleRow = typeof rule.$inferSelect;
export type RuleCondition = schema.RuleCondition;
export type RuleDraft = { name: string; condition: RuleCondition; categoryId: string | null };

const needle = z.string().trim().min(1).max(200);

const conditionSchema = z
  .strictObject({
    descriptionContains: needle.optional(),
    descriptionPattern: z
      .string()
      .refine((p) => validateWildcardPattern(p).ok, 'pattern must be 1 to 200 characters')
      .optional(),
    counterpartyContains: needle.optional(),
    amountMin: z.number().int().safe().optional(),
    amountMax: z.number().int().safe().optional(),
    direction: z.enum(['in', 'out']).optional(),
    accountIds: z.array(z.uuid()).min(1).max(100).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), 'condition must not be empty')
  .refine(
    (c) => c.amountMin === undefined || c.amountMax === undefined || c.amountMin <= c.amountMax,
    'amountMin must not exceed amountMax',
  );

/** The rule condition input, shared with the MCP `create_rule` tool. */
export const ruleConditionSchema = conditionSchema;

const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  condition: conditionSchema,
  categoryId: z.string(),
  priority: z.number().int().safe().optional(),
  enabled: z.boolean().optional(),
});
const patchSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  condition: conditionSchema.optional(),
  categoryId: z.string().optional(),
  priority: z.number().int().safe().optional(),
  enabled: z.boolean().optional(),
});

export type CreateRuleInput = z.input<typeof createSchema>;
export type UpdateRulePatch = z.input<typeof patchSchema>;

const PRIORITY_STEP = 10;

/** The stored condition holds single needles; the matcher in @arfolio/core takes any-of lists. */
export function toCoreRule(
  r: Pick<RuleRow, 'id' | 'priority' | 'enabled' | 'condition' | 'categoryId'>,
): CoreRule {
  const c = r.condition;
  return {
    id: r.id,
    priority: r.priority,
    enabled: r.enabled,
    categoryId: r.categoryId,
    condition: {
      ...(c.descriptionContains !== undefined
        ? { descriptionContains: [c.descriptionContains] }
        : {}),
      ...(c.descriptionPattern !== undefined ? { descriptionPattern: c.descriptionPattern } : {}),
      ...(c.counterpartyContains !== undefined
        ? { counterpartyContains: [c.counterpartyContains] }
        : {}),
      ...(c.amountMin !== undefined ? { amountMin: c.amountMin } : {}),
      ...(c.amountMax !== undefined ? { amountMax: c.amountMax } : {}),
      ...(c.direction !== undefined ? { direction: c.direction } : {}),
      ...(c.accountIds !== undefined ? { accountIds: c.accountIds } : {}),
    },
  };
}

async function requireRule(tx: Tx, ctx: ServiceCtx, id: string): Promise<RuleRow> {
  assertUuid(id, 'Rule');
  const [row] = await tx
    .select()
    .from(rule)
    .where(and(eq(rule.id, id), eq(rule.householdId, ctx.householdId)));
  if (!row) throw new NotFoundError('Rule');
  return row;
}

/** An active (non-archived) category of this household; NotFound/Validation otherwise. */
export async function requireUsableCategory(tx: Tx, ctx: ServiceCtx, id: string): Promise<void> {
  assertUuid(id, 'Category');
  const [row] = await tx
    .select({ archivedAt: category.archivedAt })
    .from(category)
    .where(and(eq(category.id, id), eq(category.householdId, ctx.householdId)));
  if (!row) throw new NotFoundError('Category');
  if (row.archivedAt) throw new ValidationError('Category is archived');
}

/**
 * A category a rule may assign: usable, and not the transfer category, which only
 * linking two legs (markTransfer / matching) may assign.
 */
async function requireRuleTarget(tx: Tx, ctx: ServiceCtx, id: string): Promise<void> {
  await requireUsableCategory(tx, ctx, id);
  const [row] = await tx
    .select({ kind: categoryGroup.kind, templateKey: category.templateKey })
    .from(category)
    .innerJoin(
      categoryGroup,
      and(
        eq(categoryGroup.id, category.groupId),
        eq(categoryGroup.householdId, category.householdId),
      ),
    )
    .where(and(eq(category.id, id), eq(category.householdId, ctx.householdId)));
  if (row?.kind === 'transfer' || row?.templateKey === TRANSFER_CATEGORY_KEY) {
    throw new ValidationError('Rules cannot assign the transfer category');
  }
}

/** Rules in the order they are applied: ascending priority, then id. */
export async function listRules(ctx: ServiceCtx): Promise<RuleRow[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(rule)
      .where(eq(rule.householdId, ctx.householdId))
      .orderBy(rule.priority, rule.id),
  );
}

export async function getRule(ctx: ServiceCtx, id: string): Promise<RuleRow> {
  return withHousehold(ctx.db, ctx.householdId, (tx) => requireRule(tx, ctx, id));
}

export async function createRule(
  ctx: ServiceCtx,
  rawInput: CreateRuleInput,
  opts: WriteOpts<RuleRow> = {},
): Promise<RuleRow> {
  assertCanWrite(ctx);
  const input = parseInput(createSchema, rawInput);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const created = await createRuleInTx(tx, ctx, input);
    await opts.onCommit?.(tx, created);
    return created;
  });
}

/** Inserts a rule inside the caller's household transaction (input already validated). */
export async function createRuleInTx(
  tx: Tx,
  ctx: ServiceCtx,
  input: z.output<typeof createSchema>,
): Promise<RuleRow> {
  await requireRuleTarget(tx, ctx, input.categoryId);
  let priority = input.priority;
  if (priority === undefined) {
    const [max] = await tx
      .select({ max: sql<number | null>`max(${rule.priority})` })
      .from(rule)
      .where(eq(rule.householdId, ctx.householdId));
    priority = (max?.max ?? 0) + PRIORITY_STEP;
  }
  const [row] = await tx
    .insert(rule)
    .values({
      householdId: ctx.householdId,
      name: input.name,
      condition: input.condition,
      categoryId: input.categoryId,
      priority,
      enabled: input.enabled ?? true,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

/**
 * Rewrites the rule order: `ids` are the household's rules in the order they should apply (every
 * rule exactly once, at most 500), in one transaction.
 */
export async function reorderRules(ctx: ServiceCtx, ids: string[]): Promise<void> {
  assertCanWrite(ctx);
  const list = parseInput(z.array(z.uuid()).min(1).max(500), ids);
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const existing = await tx
      .select({ id: rule.id })
      .from(rule)
      .where(eq(rule.householdId, ctx.householdId));
    if (
      new Set(list).size !== list.length ||
      existing.length !== list.length ||
      !existing.every((r) => list.includes(r.id))
    ) {
      throw new ValidationError('The order must list every rule exactly once');
    }
    for (const [index, id] of list.entries()) {
      await tx
        .update(rule)
        .set({ priority: (index + 1) * PRIORITY_STEP })
        .where(and(eq(rule.id, id), eq(rule.householdId, ctx.householdId)));
    }
  });
}

export async function updateRule(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateRulePatch,
): Promise<RuleRow> {
  assertCanWrite(ctx);
  assertUuid(id, 'Rule');
  const patch = parseInput(patchSchema, rawPatch);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const current = await requireRule(tx, ctx, id);
    if (patch.categoryId !== undefined) await requireRuleTarget(tx, ctx, patch.categoryId);
    if (Object.keys(patch).length === 0) return current;
    const [row] = await tx.update(rule).set(patch).where(eq(rule.id, id)).returning();
    return row!;
  });
}

export async function deleteRule(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Rule');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await requireRule(tx, ctx, id);
    await tx.delete(rule).where(eq(rule.id, id));
  });
}

/**
 * Proposes a rule from a transaction the user just categorised: it matches the counterparty when
 * there is one, otherwise the merchant key (normalised description). The draft is not saved.
 */
export async function suggestRuleFromCorrection(ctx: ServiceCtx, txId: string): Promise<RuleDraft> {
  assertUuid(txId, 'Transaction');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.id, txId), eq(transaction.householdId, ctx.householdId)));
    if (!row) throw new NotFoundError('Transaction');
    return ruleDraftOf(row);
  });
}

/** The rule a correction of `row` would propose (see suggestRuleFromCorrection). */
export function ruleDraftOf(
  row: Pick<typeof transaction.$inferSelect, 'counterparty' | 'rawDescription' | 'categoryId'>,
): RuleDraft {
  const counterparty = row.counterparty?.trim();
  const text = counterparty || merchantKey(row.rawDescription);
  const condition: RuleCondition = counterparty
    ? { counterpartyContains: counterparty }
    : { descriptionContains: text };
  return { name: text.slice(0, 120), condition, categoryId: row.categoryId };
}

export interface CategorisationResult {
  byRule: number;
  byMemory: number;
  needsReview: number;
}

const CONFIDENCE = { rule: 1, memory: 0.9 } as const;
const ID_CHUNK = 1_000;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Categorises the given transactions: the first matching rule wins, else the merchant memory,
 * else the row is flagged for review. Rows the user categorised and transfer legs are skipped.
 * A row with no match keeps whatever automatic category it already had. Updates are grouped, so
 * the cost is a few statements per batch rather than one per row.
 */
export async function categorizeInTx(
  tx: Tx,
  householdId: string,
  ids: string[],
): Promise<CategorisationResult> {
  const result: CategorisationResult = { byRule: 0, byMemory: 0, needsReview: 0 };
  if (ids.length === 0) return result;

  const rules = (
    await tx
      .select()
      .from(rule)
      .where(and(eq(rule.householdId, householdId), eq(rule.enabled, true)))
  ).map(toCoreRule);
  const merchants = new Map(
    (await tx.select().from(merchant).where(eq(merchant.householdId, householdId))).map((m) => [
      m.key,
      m,
    ]),
  );

  const byCategory = new Map<
    string,
    { categoryId: string; by: 'rule' | 'memory'; ids: string[] }
  >();
  const merchantLinks = new Map<string, string[]>();
  const flag: string[] = [];

  for (const idChunk of chunks(ids, ID_CHUNK)) {
    const rows = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, idChunk)));
    for (const row of rows) {
      if (row.categorisedBy === 'user' || row.transferGroupId !== null) continue;
      const known = merchants.get(merchantKey(row.rawDescription, row.counterparty));
      if (known && row.merchantId !== known.id) {
        merchantLinks.set(known.id, [...(merchantLinks.get(known.id) ?? []), row.id]);
      }
      const matched = matchRule(
        {
          description: row.rawDescription,
          counterparty: row.counterparty,
          amount: row.amount,
          accountId: row.accountId,
        },
        rules,
      );
      const hit = matched
        ? ({ categoryId: matched.categoryId, by: 'rule' } as const)
        : known?.defaultCategoryId
          ? ({ categoryId: known.defaultCategoryId, by: 'memory' } as const)
          : null;
      if (hit) {
        const key = `${hit.by}:${hit.categoryId}`;
        const group = byCategory.get(key) ?? { ...hit, ids: [] };
        group.ids.push(row.id);
        byCategory.set(key, group);
        if (hit.by === 'rule') result.byRule += 1;
        else result.byMemory += 1;
      } else if (row.categoryId === null) {
        flag.push(row.id);
        result.needsReview += 1;
      }
    }
  }

  for (const group of byCategory.values()) {
    for (const idChunk of chunks(group.ids, ID_CHUNK)) {
      await tx
        .update(transaction)
        .set({
          categoryId: group.categoryId,
          categorisedBy: group.by,
          confidence: CONFIDENCE[group.by],
          needsReview: false,
        })
        .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, idChunk)));
    }
  }
  for (const [merchantId, rowIds] of merchantLinks) {
    for (const idChunk of chunks(rowIds, ID_CHUNK)) {
      await tx
        .update(transaction)
        .set({ merchantId })
        .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, idChunk)));
    }
  }
  for (const idChunk of chunks(flag, ID_CHUNK)) {
    await tx
      .update(transaction)
      .set({ needsReview: true })
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, idChunk)));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Applying one rule to the transactions that already exist
// ---------------------------------------------------------------------------------------------

export interface RuleApplicationPreview {
  /** Eligible rows this rule would categorise (a higher-priority rule that matches wins). */
  matches: number;
  /** Of those, the rows whose category or provenance would actually change. */
  changes: number;
}

type EligibleRow = {
  id: string;
  rawDescription: string;
  counterparty: string | null;
  amount: number;
  accountId: string;
  categoryId: string | null;
  categorisedBy: 'rule' | 'memory' | 'ai' | 'user' | null;
  needsReview: boolean;
  confidence: number | null;
};

/**
 * Rows the rule would claim, found in TypeScript over the household's eligible transactions (not
 * user-categorised, not transfer legs, any status). Only the rule's own matches are returned,
 * each tagged with whether applying would change it. A disabled rule claims nothing.
 */
async function claimedRows(
  tx: Tx,
  ctx: ServiceCtx,
  target: RuleRow,
): Promise<{ matched: number; toChange: EligibleRow[] }> {
  await requireRuleTarget(tx, ctx, target.categoryId);
  if (!target.enabled) return { matched: 0, toChange: [] };
  const rules = (
    await tx
      .select()
      .from(rule)
      .where(and(eq(rule.householdId, ctx.householdId), eq(rule.enabled, true)))
  ).map(toCoreRule);
  const rows = await tx
    .select({
      id: transaction.id,
      rawDescription: transaction.rawDescription,
      counterparty: transaction.counterparty,
      amount: transaction.amount,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      categorisedBy: transaction.categorisedBy,
      needsReview: transaction.needsReview,
      confidence: transaction.confidence,
    })
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, ctx.householdId),
        isNull(transaction.transferGroupId),
        or(isNull(transaction.categorisedBy), ne(transaction.categorisedBy, 'user')),
      ),
    );
  let matched = 0;
  const toChange: EligibleRow[] = [];
  for (const row of rows) {
    const hit = matchRule(
      {
        description: row.rawDescription,
        counterparty: row.counterparty,
        amount: row.amount,
        accountId: row.accountId,
      },
      rules,
    );
    if (hit?.id !== target.id) continue;
    matched += 1;
    if (row.categoryId !== target.categoryId || row.categorisedBy !== 'rule') toChange.push(row);
  }
  return { matched, toChange };
}

/** Read-only (viewers allowed): what `applyRule` would do right now. */
export async function previewRuleApplication(
  ctx: ServiceCtx,
  ruleId: string,
): Promise<RuleApplicationPreview> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const target = await requireRule(tx, ctx, ruleId);
    const { matched, toChange } = await claimedRows(tx, ctx, target);
    return { matches: matched, changes: toChange.length };
  });
}

const ruleApplicationPayload = z.strictObject({
  ruleId: z.uuid(),
  categoryId: z.uuid(),
  rows: z.array(
    z.strictObject({
      id: z.uuid(),
      categoryId: z.uuid().nullable(),
      categorisedBy: z.enum(['rule', 'memory', 'ai', 'user']).nullable(),
      confidence: z.number().nullable(),
      needsReview: z.boolean(),
    }),
  ),
});

/**
 * Categorises the existing transactions the rule claims (see `previewRuleApplication`) in one
 * transaction, and records an undo token holding each row's previous state. A disabled rule, or
 * nothing to change, yields `{ changed: 0, undoToken: null }`.
 */
export async function applyRule(
  ctx: ServiceCtx,
  ruleId: string,
): Promise<{ changed: number; undoToken: string | null }> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const target = await requireRule(tx, ctx, ruleId);
    const { toChange } = await claimedRows(tx, ctx, target);
    let token: string | null = null;
    // Eligibility is re-asserted in the UPDATE itself (not user-categorised, not a transfer leg),
    // and the rows that really changed come back from it: a person who hand-categorises a row
    // between the SELECT above and this UPDATE keeps their choice, and that row is neither counted
    // nor in the undo payload. (Under READ COMMITTED the UPDATE re-checks a row another
    // transaction changed in the meantime against this WHERE.)
    const changedIds = new Set<string>();
    if (toChange.length > 0) {
      for (const idChunk of chunks(
        toChange.map((r) => r.id),
        ID_CHUNK,
      )) {
        const done = await tx
          .update(transaction)
          .set({
            categoryId: target.categoryId,
            categorisedBy: 'rule',
            confidence: CONFIDENCE.rule,
            needsReview: false,
          })
          .where(
            and(
              eq(transaction.householdId, ctx.householdId),
              inArray(transaction.id, idChunk),
              isNull(transaction.transferGroupId),
              or(isNull(transaction.categorisedBy), ne(transaction.categorisedBy, 'user')),
            ),
          )
          .returning({ id: transaction.id });
        for (const r of done) changedIds.add(r.id);
      }
    }
    const applied = toChange.filter((r) => changedIds.has(r.id));
    if (applied.length > 0) {
      await tx.delete(undoToken).where(lt(undoToken.expiresAt, sql`now()`));
      const [row] = await tx
        .insert(undoToken)
        .values({
          householdId: ctx.householdId,
          userId: ctx.userId,
          kind: 'rule_application',
          payload: {
            ruleId: target.id,
            categoryId: target.categoryId,
            rows: applied.map((r) => ({
              id: r.id,
              categoryId: r.categoryId,
              categorisedBy: r.categorisedBy,
              confidence: r.confidence,
              needsReview: r.needsReview,
            })),
          },
          expiresAt: sql`now() + interval '15 minutes'`,
        })
        .returning({ id: undoToken.id });
      token = row!.id;
    }
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'rule.apply',
      targetType: 'rule',
      targetId: ruleId,
    });
    return { changed: applied.length, undoToken: token };
  });
}

/**
 * Undoes `applyRule` with its token (the caller's own, unused, unexpired; spent here). Only rows
 * still exactly as the apply left them (the rule's category, categorised by 'rule') are restored;
 * rows changed since are left alone and counted in `kept`.
 */
export async function revertRuleApplication(
  ctx: ServiceCtx,
  token: string,
): Promise<{ restored: number; kept: number }> {
  assertCanWrite(ctx);
  assertUuid(token, 'Undo token');
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.delete(undoToken).where(lt(undoToken.expiresAt, sql`now()`)),
  );
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
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
    if (!stored || stored.userId !== ctx.userId || stored.kind !== 'rule_application') {
      throw new NotFoundError('Undo token');
    }
    if (stored.usedAt) throw new ValidationError('This undo was already used');
    const snap = parseInput(ruleApplicationPayload, stored.payload);
    await tx.update(undoToken).set({ usedAt: new Date() }).where(eq(undoToken.id, stored.id));

    // Rows sharing a previous state are restored together.
    const groups = new Map<string, { prev: (typeof snap.rows)[number]; ids: string[] }>();
    for (const r of snap.rows) {
      const key = JSON.stringify([r.categoryId, r.categorisedBy, r.confidence, r.needsReview]);
      const g = groups.get(key) ?? { prev: r, ids: [] };
      g.ids.push(r.id);
      groups.set(key, g);
    }
    let restored = 0;
    for (const g of groups.values()) {
      for (const idChunk of chunks(g.ids, ID_CHUNK)) {
        const done = await tx
          .update(transaction)
          .set({
            categoryId: g.prev.categoryId,
            categorisedBy: g.prev.categorisedBy,
            confidence: g.prev.confidence,
            needsReview: g.prev.needsReview,
          })
          .where(
            and(
              eq(transaction.householdId, ctx.householdId),
              inArray(transaction.id, idChunk),
              eq(transaction.categoryId, snap.categoryId),
              eq(transaction.categorisedBy, 'rule'),
            ),
          )
          .returning({ id: transaction.id });
        restored += done.length;
      }
    }
    return { restored, kept: snap.rows.length - restored };
  });
}
