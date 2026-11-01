import { and, asc, desc, eq, inArray, isNull, lt, ne, not, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { APIConnectionError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { mccLabel } from '@arfolio/core';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import { TRANSFER_CATEGORY_KEY } from '../category-templates.js';
import { assertUuid } from '../context.js';
import {
  aiOutputSchema,
  buildSystemBlocks,
  buildUserMessage,
  formatAmount,
  type PromptCategory,
  type PromptRow,
  type SystemBlock,
} from './prompt.js';
import { resolveFallbackCategory } from './fallback-category.js';
import { redactForAi } from './redact.js';
import { awaitingT212Export } from '../t212-pending.js';

const { category, categoryGroup, householdSettings, organization, transaction } = schema;

/** An answer at or above this confidence leaves review; below it the row stays for a person. */
export const AI_APPLY_THRESHOLD = 0.85;
/** Times a row is sent to the model; without a category after that it falls back to "Outros". */
export const AI_MAX_ATTEMPTS = 3;
/** Rows per model call. */
export const AI_BATCH_SIZE = 100;
/** Rows per pass: one pass loads this many waiting rows and sends them in batches. */
export const AI_MAX_ROWS_PER_RUN = 500;
/**
 * Passes per run: a run keeps loading the next rows until none is waiting, up to this many
 * passes, which bounds the cost of one run (the next check picks up the rest).
 */
export const AI_MAX_PASSES_PER_RUN = 20;
/**
 * A run starts no new batch after this long, so it ends well inside the worker job's expiry
 * (a batch can take a few minutes with the SDK's timeout and retries).
 */
export const AI_MAX_RUN_MS = 30 * 60_000;
const MAX_OUTPUT_TOKENS = 8_192;

const outputFormat = () => zodOutputFormat(aiOutputSchema);

export type AiParseParams = {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  messages: Array<{ role: 'user'; content: string }>;
  /** The structured-output format of whichever feature calls (categorisation, reports). */
  output_config: { format: ReturnType<typeof zodOutputFormat> };
};
export type AiParseResult = {
  parsed_output: unknown;
  stop_reason?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
};

/** The one SDK method this module uses, so tests can fake it without the network. */
export interface AnthropicLike {
  messages: { parse(params: AiParseParams): Promise<AiParseResult> };
}

export interface AiLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type AiCategoriseDeps = {
  db: Db;
  /** `null` when the installation has no API key: the run is skipped. */
  anthropic: AnthropicLike | null;
  model: string;
  /** Receives counts and error classes only, never transaction text or keys. */
  logger: AiLogger;
  /** Overrides for tests; production uses the defaults above. */
  maxRowsPerRun?: number;
  batchSize?: number;
  maxPassesPerRun?: number;
  maxRunMs?: number;
  now?: () => number;
};

export type AiCategoriseResult = {
  status: 'done' | 'disabled' | 'no_api_key' | 'rate_limited';
  /** Rows categorised by the model with confidence 0.85 or more (out of review). */
  applied: number;
  /** Rows categorised by the model with lower confidence, left in review. */
  review: number;
  /** Rows that used their last attempt and were given "Outros" (or "Outras receitas"). */
  fallback: number;
  /** Candidate rows still without a category (not sent this run, or to be retried). */
  skipped: number;
  inputTokens: number;
  outputTokens: number;
};

function isUuid(id: string): boolean {
  try {
    assertUuid(id, 'Transaction');
    return true;
  } catch {
    return false;
  }
}

const itemSchema = aiOutputSchema.shape.items.element;

const EMPTY: Omit<AiCategoriseResult, 'status'> = {
  applied: 0,
  review: 0,
  fallback: 0,
  skipped: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Rate limits, provider outages, a network failure or timeout, and a broken key or account (401,
 * 403, billing or quota 400s) end the run and never count an attempt: the next run tries again
 * once it is fixed. Only failures about the batch itself count.
 */
export function isStopError(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  const { status, message } = (err ?? {}) as { status?: unknown; message?: unknown };
  if (typeof status !== 'number') return false;
  if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
  return (
    status === 400 && typeof message === 'string' && /credit balance|billing|quota/i.test(message)
  );
}

function isForeignKeyError(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return code(err) === '23503' || code((err as { cause?: unknown } | null)?.cause) === '23503';
}

/** A label that is safe to log: the HTTP status or the error class, never the message. */
export function errorLabel(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `http ${status}`;
  return err instanceof Error ? err.name : 'unknown';
}

type Candidate = {
  id: string;
  rawDescription: string;
  counterparty: string | null;
  amount: number;
  currency: string;
  bookingDate: string;
  mcc: string | null;
};

/**
 * The rows the AI judges: uncategorised, unedited, booked, not a transfer, under three attempts,
 * and not a Trading 212 card row the export has yet to name.
 */
function aiCandidateFilter(householdId: string) {
  return and(
    eq(transaction.householdId, householdId),
    eq(transaction.status, 'booked'),
    isNull(transaction.categoryId),
    isNull(transaction.userEditedAt),
    isNull(transaction.transferGroupId),
    // A card row the Trading 212 export has yet to name would be judged blind.
    not(awaitingT212Export(householdId)),
    // A row is sent at most this many times (see applyBatch).
    lt(transaction.aiAttempts, AI_MAX_ATTEMPTS),
  );
}

/** The household's categories as offered to the model, or `null` when the household has AI off. */
async function loadCategories(
  deps: AiCategoriseDeps,
  householdId: string,
): Promise<Array<PromptCategory & { realId: string }> | null> {
  return withHousehold(deps.db, householdId, async (tx) => {
    const [settings] = await tx
      .select({ aiEnabled: householdSettings.aiEnabled })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    if (!settings?.aiEnabled) return null;

    const rows = await tx
      .select({
        id: category.id,
        name: category.name,
        group: categoryGroup.name,
        kind: categoryGroup.kind,
      })
      .from(category)
      .innerJoin(
        categoryGroup,
        and(
          eq(category.groupId, categoryGroup.id),
          eq(category.householdId, categoryGroup.householdId),
        ),
      )
      .where(
        and(
          eq(category.householdId, householdId),
          isNull(category.archivedAt),
          isNull(categoryGroup.archivedAt),
          ne(categoryGroup.kind, 'transfer'),
          or(isNull(category.templateKey), ne(category.templateKey, TRANSFER_CATEGORY_KEY)),
        ),
      )
      .orderBy(
        asc(categoryGroup.sort),
        asc(categoryGroup.name),
        asc(category.sort),
        asc(category.name),
        asc(category.id),
      );
    return rows.map((r, i) => ({
      realId: r.id,
      id: `c${i + 1}`,
      name: r.name,
      group: r.group,
      kind: r.kind as PromptCategory['kind'],
    }));
  });
}

/** The next waiting rows, newest first, leaving out the rows already sent in this run. */
async function loadCandidates(
  deps: AiCategoriseDeps,
  householdId: string,
  transactionIds: string[] | undefined,
  sent: Set<string>,
): Promise<Candidate[]> {
  const maxRows = deps.maxRowsPerRun ?? AI_MAX_ROWS_PER_RUN;
  // One array parameter, however many rows were sent (ids come from the database: uuids).
  const sentArray = `{${[...sent].join(',')}}`;
  return withHousehold(deps.db, householdId, (tx) =>
    tx
      .select({
        id: transaction.id,
        rawDescription: transaction.rawDescription,
        counterparty: transaction.counterparty,
        amount: transaction.amount,
        currency: transaction.currency,
        bookingDate: transaction.bookingDate,
        mcc: transaction.mcc,
      })
      .from(transaction)
      .where(
        and(
          aiCandidateFilter(householdId),
          ...(transactionIds ? [inArray(transaction.id, transactionIds)] : []),
          ...(sent.size > 0 ? [sql`not (${transaction.id} = any(${sentArray}::uuid[]))`] : []),
        ),
      )
      .orderBy(desc(transaction.bookingDate), asc(transaction.id))
      .limit(maxRows),
  );
}

type Decision = {
  id: string;
  categoryId: string | null;
  confidence: number;
  /** False when the category kind contradicts the amount sign: never applied. */
  kindFits: boolean;
};

/**
 * Spending needs an expense or saving category. Money received takes an income or saving one,
 * or an expense one: that is a refund, which reduces the spending it reverses.
 */
function kindFitsAmount(kind: PromptCategory['kind'] | undefined, amount: number): boolean {
  if (kind === undefined) return false;
  if (kind === 'saving' || amount === 0) return true;
  return amount < 0 ? kind === 'expense' : true;
}

/**
 * Turns the model's answer into decisions, dropping what cannot be trusted: unknown ids,
 * unknown categories, duplicate answers (the first wins) and malformed items. Confidence is
 * clamped to 0..1.
 */
function readDecisions(
  parsed: unknown,
  batch: Candidate[],
  refToId: Map<string, string>,
  categoryByRef: Map<string, { realId: string; kind: PromptCategory['kind'] }>,
): Decision[] {
  const amounts = new Map(batch.map((c) => [c.id, c.amount]));
  const list = z.object({ items: z.array(z.unknown()) }).safeParse(parsed);
  if (!list.success) return [];
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const raw of list.data.items) {
    const item = itemSchema.safeParse(raw);
    if (!item.success || !Number.isFinite(item.data.confidence)) continue;
    const id = refToId.get(item.data.id);
    if (!id || seen.has(id)) continue;
    let categoryId: string | null = null;
    let kindFits = true;
    if (item.data.categoryId !== null) {
      const known = categoryByRef.get(item.data.categoryId);
      if (!known) continue; // a category we never offered
      categoryId = known.realId;
      kindFits = kindFitsAmount(known.kind, amounts.get(id) ?? 0);
    }
    seen.add(id);
    out.push({
      id,
      categoryId,
      kindFits,
      confidence: Math.min(1, Math.max(0, item.data.confidence)),
    });
  }
  // Rows the model skipped or answered unusably still used an attempt (see applyBatch).
  for (const c of batch) {
    if (!seen.has(c.id)) {
      out.push({ id: c.id, categoryId: null, confidence: 0, kindFits: true });
    }
  }
  return out;
}

type BatchCounts = { applied: number; review: number; fallback: number };

/** Every update carries the guard "still uncategorised, never edited by a user, not a transfer". */
const stillOpen = (householdId: string, ids: string[]) =>
  and(
    eq(transaction.householdId, householdId),
    inArray(transaction.id, ids),
    isNull(transaction.categoryId),
    isNull(transaction.userEditedAt),
    isNull(transaction.transferGroupId),
  );

/**
 * Counts one attempt for rows that stayed without a category. A row that reaches the last
 * attempt is given the household's "Outros" (outflow) or "Outras receitas" (inflow) and stays in
 * review, so the rule "three tries, then Outros" holds.
 */
async function recordFailedAttempts(tx: Tx, householdId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const bumped = await tx
    .update(transaction)
    .set({ aiAttempts: sql`${transaction.aiAttempts} + 1` })
    // A row whose attempts were capped meanwhile (an undone AI category) is left alone.
    .where(and(stillOpen(householdId, ids), lt(transaction.aiAttempts, AI_MAX_ATTEMPTS)))
    .returning({
      id: transaction.id,
      attempts: transaction.aiAttempts,
      amount: transaction.amount,
    });
  const spent = bumped.filter((r) => r.attempts >= AI_MAX_ATTEMPTS);
  let fallback = 0;
  for (const kind of ['expense', 'income'] as const) {
    const rows = spent.filter((r) => r.amount > 0 === (kind === 'income'));
    if (rows.length === 0) continue;
    const categoryId = await resolveFallbackCategory(tx, householdId, kind);
    const updated = await tx
      .update(transaction)
      .set({
        categoryId,
        categorisedBy: 'ai',
        confidence: 0,
        aiConfidence: 0,
        needsReview: true,
      })
      .where(
        stillOpen(
          householdId,
          rows.map((r) => r.id),
        ),
      )
      .returning({ id: transaction.id });
    fallback += updated.length;
  }
  return fallback;
}

/** A batch that failed or came back unusable: its rows were sent, so each used an attempt. */
async function failBatch(
  deps: AiCategoriseDeps,
  householdId: string,
  batch: Candidate[],
): Promise<number> {
  return withHousehold(deps.db, householdId, (tx) =>
    recordFailedAttempts(
      tx,
      householdId,
      batch.map((c) => c.id),
    ),
  );
}

/**
 * Writes one batch of decisions in one transaction. Every row counts an attempt. An answer whose
 * category fits the amount sign is applied (out of review from 0.85, in review below); anything
 * else is a failed attempt (see `recordFailedAttempts`). A user's edit made while the model was
 * answering wins, because of the `stillOpen` guard.
 */
async function applyBatch(
  deps: AiCategoriseDeps,
  householdId: string,
  decisions: Decision[],
): Promise<BatchCounts> {
  const counts: BatchCounts = { applied: 0, review: 0, fallback: 0 };
  if (decisions.length === 0) return counts;
  return withHousehold(deps.db, householdId, async (tx) => {
    const failed: string[] = [];
    for (const d of decisions) {
      if (d.categoryId === null || !d.kindFits) {
        failed.push(d.id);
        continue;
      }
      const high = d.confidence >= AI_APPLY_THRESHOLD;
      let updated: Array<{ id: string }>;
      try {
        // A savepoint, so one failing row does not abort the whole transaction.
        updated = await tx.transaction((sp) =>
          sp
            .update(transaction)
            .set({
              categoryId: d.categoryId,
              categorisedBy: 'ai',
              confidence: d.confidence,
              aiConfidence: d.confidence,
              needsReview: !high,
              aiAttempts: sql`${transaction.aiAttempts} + 1`,
            })
            .where(stillOpen(householdId, [d.id]))
            .returning({ id: transaction.id }),
        );
      } catch (err) {
        // The category was deleted while the model was answering: a failed attempt.
        if (isForeignKeyError(err)) {
          deps.logger.warn('ai categorise: a category no longer exists, counted as an attempt');
          failed.push(d.id);
          continue;
        }
        throw err;
      }
      if (updated.length > 0) {
        if (high) counts.applied += 1;
        else counts.review += 1;
      }
    }
    counts.fallback = await recordFailedAttempts(tx, householdId, failed);
    return counts;
  });
}

/**
 * Asks the model to categorise the household's rows that rules and merchant memory left without
 * a category. Runs only when the household has AI on and the installation has an API key.
 *
 *  - any answer with a category that fits the amount sign is applied (`categorised_by = 'ai'`);
 *    confidence >= 0.85 leaves review, lower confidence keeps the row in review
 *  - a row is sent at most three times; if it still has no category after the third (no answer,
 *    no category, a misfit or a failed call) it gets "Outros" / "Outras receitas", in review
 *  - a run works through every waiting row, a pass of up to 500 rows at a time (at most 20
 *    passes), sending each row at most once per run
 *
 * A batch that fails or comes back unusable is logged and counts as an attempt for its rows; a
 * 429 or 5xx stops the run and counts nothing, since the provider never judged the rows.
 */
export async function aiCategorise(
  deps: AiCategoriseDeps,
  input: { householdId: string; transactionIds?: string[] },
): Promise<AiCategoriseResult> {
  const { anthropic, logger } = deps;
  if (!anthropic) return { status: 'no_api_key', ...EMPTY };
  const ids = input.transactionIds?.filter(isUuid);
  if (ids && ids.length === 0) return { status: 'done', ...EMPTY };
  const categories = await loadCategories(deps, input.householdId);
  if (!categories) return { status: 'disabled', ...EMPTY };
  const result: AiCategoriseResult = { status: 'done', ...EMPTY };
  if (categories.length === 0) return result;

  const categoryByRef = new Map(categories.map((c) => [c.id, { realId: c.realId, kind: c.kind }]));
  const system = buildSystemBlocks(
    categories.map(({ id, name, group, kind }) => ({ id, name, group, kind })),
  );
  const size = Math.min(deps.batchSize ?? AI_BATCH_SIZE, AI_BATCH_SIZE);
  const maxPasses = deps.maxPassesPerRun ?? AI_MAX_PASSES_PER_RUN;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.maxRunMs ?? AI_MAX_RUN_MS);
  let outOfTime = false;

  // Each pass loads the next waiting rows; a row is sent at most once per run, so a row left
  // without a category waits for a later run instead of using all its attempts at once.
  const sent = new Set<string>();
  let total = 0;
  let cacheWritten = 0;
  let cacheRead = 0;
  for (let pass = 0; pass < maxPasses && result.status === 'done' && !outOfTime; pass += 1) {
    const candidates = await loadCandidates(deps, input.householdId, ids, sent);
    if (candidates.length === 0) break;
    total += candidates.length;
    for (const c of candidates) sent.add(c.id);
    const batches: Candidate[][] = [];
    for (let i = 0; i < candidates.length; i += size) batches.push(candidates.slice(i, i + size));

    for (const [n, batch] of batches.entries()) {
      if (now() >= deadline) {
        // The rows not sent yet wait for the next run (counted as skipped).
        logger.info(`ai categorise: out of time at pass ${pass + 1}, batch ${n + 1}`);
        outOfTime = true;
        break;
      }
      const where = `pass ${pass + 1}, batch ${n + 1}/${batches.length}`;
      const refToId = new Map<string, string>();
      const rows: PromptRow[] = batch.map((c, i) => {
        const ref = `t${i + 1}`;
        refToId.set(ref, c.id);
        const counterparty = c.counterparty ? redactForAi(c.counterparty) : '';
        return {
          id: ref,
          description: redactForAi(c.rawDescription),
          counterparty: counterparty || null,
          amount: formatAmount(c.amount, c.currency),
          date: c.bookingDate.slice(0, 7),
          ...(c.mcc && { mcc: c.mcc, mccLabel: mccLabel(c.mcc, 'en') }),
        };
      });
      let response: AiParseResult;
      try {
        response = await anthropic.messages.parse({
          model: deps.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: 'user', content: buildUserMessage(rows) }],
          output_config: { format: outputFormat() },
        });
      } catch (err) {
        if (isStopError(err)) {
          logger.warn(`ai categorise stopped at ${where}: ${errorLabel(err)}`);
          result.status = 'rate_limited';
          break;
        }
        logger.warn(`ai categorise ${where} failed: ${errorLabel(err)}`);
        result.fallback += await failBatch(deps, input.householdId, batch);
        continue;
      }
      result.inputTokens += response.usage.input_tokens;
      result.outputTokens += response.usage.output_tokens;
      cacheWritten += response.usage.cache_creation_input_tokens ?? 0;
      cacheRead += response.usage.cache_read_input_tokens ?? 0;
      if (response.stop_reason === 'refusal' || response.parsed_output == null) {
        logger.warn(`ai categorise ${where} unusable (${response.stop_reason ?? 'no output'})`);
        result.fallback += await failBatch(deps, input.householdId, batch);
        continue;
      }
      const decisions = readDecisions(response.parsed_output, batch, refToId, categoryByRef);
      const counts = await applyBatch(deps, input.householdId, decisions);
      result.applied += counts.applied;
      result.review += counts.review;
      result.fallback += counts.fallback;
    }
  }
  if (total === 0) return result;
  result.skipped = total - result.applied - result.review - result.fallback;
  logger.info(
    `ai categorise: ${result.applied} applied, ${result.review} left in review, ` +
      `${result.fallback} fell back, ${result.skipped} still open, ` +
      `${result.inputTokens} input and ${result.outputTokens} output tokens ` +
      `(cache: ${cacheWritten} written, ${cacheRead} read)`,
  );
  return result;
}

/**
 * Households with AI switched on that have at least one row the AI would judge now. Cheap (no
 * model call), so the worker can ask every minute and start a run only where there is work.
 */
export async function findHouseholdsWithAiWork(db: Db): Promise<string[]> {
  const withWork: string[] = [];
  for (const householdId of await findAiHouseholds(db)) {
    const [row] = await withHousehold(db, householdId, (tx) =>
      tx
        .select({ id: transaction.id })
        .from(transaction)
        .where(aiCandidateFilter(householdId))
        .limit(1),
    );
    if (row) withWork.push(householdId);
  }
  return withWork;
}

/** Households with AI switched on, across all households (RLS needs one household at a time). */
export async function findAiHouseholds(db: Db): Promise<string[]> {
  const households = await db.select({ id: organization.id }).from(organization);
  const enabled: string[] = [];
  for (const { id } of households) {
    const [settings] = await withHousehold(db, id, (tx) =>
      tx
        .select({ aiEnabled: householdSettings.aiEnabled })
        .from(householdSettings)
        .where(eq(householdSettings.householdId, id)),
    );
    if (settings?.aiEnabled) enabled.push(id);
  }
  return enabled;
}
