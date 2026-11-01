import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { APIConnectionError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { schema, withHousehold, type Db } from '@arfolio/db';
import type { AiLogger, AiParseParams, AiParseResult, AnthropicLike } from '../ai/categorise.js';
import { assertCanWrite, parseInput, ValidationError, type ServiceCtx } from '../context.js';
import { createNotificationInTx } from '../notifications.js';
import { localDay } from '../sync.js';
import { buildFactSheet, FACT_SHEET_VERSION, hasActivity, type FactSheet } from './fact-sheet.js';
import { addMonths, firstDay, MONTH_INPUT, monthKey } from './month.js';
import {
  buildReportSystemBlocks,
  buildReportUserMessage,
  reportContentSchema,
  type ReportContent,
} from './prompt.js';

const { aiReport, householdSettings, organization } = schema;

export type AiReportRow = typeof aiReport.$inferSelect;

/** A household can regenerate a month's report this many times (counted on the row). */
export const REPORT_MAX_REGENERATIONS = 3;
/** A 429 or 5xx is retried until the row has failed this many times. */
export const REPORT_MAX_ATTEMPTS = 4;
/** Backoff after the n-th failed attempt: 5 minutes x 2^n. */
const BACKOFF_BASE_MS = 5 * 60_000;
/** A claimed row is not due again for this long, which outlasts the 120 s request timeout. */
const CLAIM_LEASE_MS = 15 * 60_000;
const MAX_OUTPUT_TOKENS = 4_096;
/**
 * The automatic report of a month waits for this local day of the next month: pending rows have
 * booked, the last syncs ran and the AI categorised, so the report is not built on half a month.
 * A person asking for it by hand (`requestReport`) is not held back.
 */
const REPORT_MIN_LOCAL_DAY = 3;

/** The report was asked for, but AI is off for the household or not set up on the installation. */
export class AiUnavailableError extends Error {
  constructor() {
    super('AI reports are not available');
    this.name = 'AiUnavailableError';
  }
}

const outputFormat = () => zodOutputFormat(reportContentSchema);

// ---------------------------------------------------------------------------------------------
// Requesting (web side: a row the worker sweep picks up, since the web has no queue connection)

const requestSchema = z.strictObject({ month: z.string().regex(MONTH_INPUT, 'expected YYYY-MM') });

/**
 * Asks for the report of `month` (owner or member). A missing row is created pending; a finished
 * one (ready, failed or skipped) goes back to pending and counts as a regeneration, at most
 * {@link REPORT_MAX_REGENERATIONS} per month. A row already pending is left as it is, so a double
 * click or a click during generation never queues a second model call. The earlier content stays
 * until the new report replaces it.
 *
 * A month that has not closed in the household time zone is refused (`month_not_closed`), and so
 * is any month before the last closed one (`month_not_allowed`).
 * `aiAvailable` is whether the installation has an API key (`isAiAvailable(env)`): services never
 * read the environment.
 */
export async function requestReport(
  ctx: ServiceCtx,
  rawInput: { month: string },
  opts: { aiAvailable: boolean; now?: Date },
): Promise<{ id: string; status: 'pending'; regenerations: number }> {
  assertCanWrite(ctx);
  const month = firstDay(monthKey(parseInput(requestSchema, rawInput).month));
  if (!opts.aiAvailable) throw new AiUnavailableError();
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [settings] = await tx
      .select({
        aiEnabled: householdSettings.aiEnabled,
        locale: householdSettings.locale,
        timezone: householdSettings.timezone,
      })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    if (!settings?.aiEnabled) throw new AiUnavailableError();
    // Only the last month closed in the household time zone gets a report.
    const open = localDay(opts.now ?? new Date(), settings.timezone).slice(0, 7);
    if (month.slice(0, 7) >= open) {
      throw new ValidationError('The month has not closed yet', [], 'month_not_closed');
    }
    if (month.slice(0, 7) !== addMonths(open, -1)) {
      throw new ValidationError(
        'Only the last closed month can be reported',
        [],
        'month_not_allowed',
      );
    }

    const [existing] = await tx
      .select()
      .from(aiReport)
      .where(and(eq(aiReport.householdId, ctx.householdId), eq(aiReport.month, month)))
      .for('update');
    if (!existing) {
      const [created] = await tx
        .insert(aiReport)
        .values({
          householdId: ctx.householdId,
          month,
          status: 'pending',
          locale: settings.locale,
          requestedBy: ctx.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { id: created.id, status: 'pending', regenerations: 0 };
      // Lost a race with another request or the sweep: the row is pending now.
      const [raced] = await tx
        .select()
        .from(aiReport)
        .where(and(eq(aiReport.householdId, ctx.householdId), eq(aiReport.month, month)));
      return { id: raced!.id, status: 'pending', regenerations: raced!.regenerations };
    }
    if (existing.status === 'pending') {
      return { id: existing.id, status: 'pending', regenerations: existing.regenerations };
    }
    if (existing.regenerations >= REPORT_MAX_REGENERATIONS) {
      throw new ValidationError(
        'The report was regenerated too many times this month',
        [],
        'regenerate_limit',
        { limit: REPORT_MAX_REGENERATIONS },
      );
    }
    await tx
      .update(aiReport)
      .set({
        status: 'pending',
        regenerations: existing.regenerations + 1,
        attempts: 0,
        nextAttemptAt: null,
        errorCode: null,
        locale: settings.locale,
        requestedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(aiReport.id, existing.id));
    return { id: existing.id, status: 'pending', regenerations: existing.regenerations + 1 };
  });
}

// ---------------------------------------------------------------------------------------------
// Reading (any role)

/** A stored report as the UI reads it: month as `yyyy-mm`, content and facts checked on the way out. */
export type ReportView = {
  id: string;
  month: string;
  status: AiReportRow['status'];
  model: string | null;
  locale: string;
  /** Null unless the stored content still matches the schema (never trusts old rows blindly). */
  content: ReportContent | null;
  /** Null unless the stored fact sheet is of the current version. */
  facts: FactSheet | null;
  errorCode: string | null;
  regenerations: number;
  createdAt: Date;
  updatedAt: Date;
};

function toView(row: AiReportRow): ReportView {
  const content = reportContentSchema.safeParse(row.content);
  const facts = row.facts as Partial<FactSheet> | null;
  return {
    id: row.id,
    month: monthKey(row.month),
    status: row.status,
    model: row.model,
    locale: row.locale,
    content: content.success ? content.data : null,
    facts: facts && facts.schemaVersion === FACT_SHEET_VERSION ? (facts as FactSheet) : null,
    errorCode: row.errorCode,
    regenerations: row.regenerations,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const listSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(24),
  /** Only months before this one (`yyyy-mm`), for "show more". */
  before: z.string().regex(MONTH_INPUT).optional(),
});

/** The household's reports, newest month first. Read-only for any role (RLS scopes the rows). */
export async function listReports(
  ctx: ServiceCtx,
  rawInput: { limit?: number; before?: string } = {},
): Promise<ReportView[]> {
  const input = parseInput(listSchema, rawInput);
  const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(aiReport)
      .where(
        and(
          eq(aiReport.householdId, ctx.householdId),
          input.before ? lt(aiReport.month, firstDay(monthKey(input.before))) : undefined,
        ),
      )
      .orderBy(desc(aiReport.month))
      .limit(input.limit),
  );
  return rows.map(toView);
}

/** The report of `month` (`yyyy-mm`), or null when there is none. Read-only for any role. */
export async function getReport(
  ctx: ServiceCtx,
  rawInput: { month: string },
): Promise<ReportView | null> {
  const month = firstDay(monthKey(parseInput(requestSchema, rawInput).month));
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(aiReport)
      .where(and(eq(aiReport.householdId, ctx.householdId), eq(aiReport.month, month))),
  );
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------------------------
// The sweep (worker side, across households: RLS needs one household at a time)

async function allHouseholds(db: Db): Promise<string[]> {
  return (
    await db.select({ id: organization.id }).from(organization).orderBy(asc(organization.id))
  ).map((h) => h.id);
}

/**
 * For every household with AI on whose previous local month (in its time zone) has no report,
 * inserts a pending one with the household locale. A month is only reported from the third day
 * of the next month locally, once its data has settled. Returns how many rows were inserted.
 */
export async function ensureMonthlyReports(
  db: Db,
  opts: { now: Date; logger?: AiLogger },
): Promise<number> {
  let inserted = 0;
  for (const householdId of await allHouseholds(db)) {
    try {
      inserted += await ensureHouseholdReport(db, householdId, opts.now);
    } catch (err) {
      skipped(opts.logger, err);
    }
  }
  return inserted;
}

/** One household failing must not stop the sweep: its error class is logged, never its id. */
function skipped(logger: AiLogger | undefined, err: unknown): void {
  logger?.warn(`ai report sweep: a household was skipped (${errorLabel(err)})`);
}

function ensureHouseholdReport(db: Db, householdId: string, now: Date): Promise<number> {
  return withHousehold(db, householdId, async (tx) => {
    const [settings] = await tx
      .select({
        aiEnabled: householdSettings.aiEnabled,
        timezone: householdSettings.timezone,
        locale: householdSettings.locale,
      })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    if (!settings?.aiEnabled) return 0;
    const today = localDay(now, settings.timezone);
    if (Number(today.slice(8, 10)) < REPORT_MIN_LOCAL_DAY) return 0;
    const previous = addMonths(today.slice(0, 7), -1);
    const rows = await tx
      .insert(aiReport)
      .values({
        householdId,
        month: firstDay(previous),
        status: 'pending',
        locale: settings.locale,
      })
      .onConflictDoNothing()
      .returning({ id: aiReport.id });
    return rows.length;
  });
}

/**
 * Claims up to `limit` due pending reports (`next_attempt_at` empty or past) with
 * `for update skip locked`, and leases each one by pushing `next_attempt_at` out, in the same
 * transaction. Another sweep therefore skips a row that is locked and, once the claim commits,
 * no longer sees it as due: a row is generated by one worker at a time. A worker that dies
 * leaves the row to be picked up again when the lease runs out. Claiming counts as an attempt
 * (`attempts` + 1), so the paid calls per row stay bounded even when settling the result fails.
 */
export async function claimPendingReports(
  db: Db,
  opts: { now: Date; limit: number; logger?: AiLogger },
): Promise<AiReportRow[]> {
  const claimed: AiReportRow[] = [];
  for (const householdId of await allHouseholds(db)) {
    const room = opts.limit - claimed.length;
    if (room <= 0) break;
    try {
      claimed.push(...(await claimHousehold(db, householdId, room, opts.now)));
    } catch (err) {
      skipped(opts.logger, err);
    }
  }
  return claimed;
}

function claimHousehold(
  db: Db,
  householdId: string,
  room: number,
  now: Date,
): Promise<AiReportRow[]> {
  return withHousehold(db, householdId, async (tx) => {
    const due = await tx
      .select({ id: aiReport.id })
      .from(aiReport)
      .where(
        and(
          eq(aiReport.householdId, householdId),
          eq(aiReport.status, 'pending'),
          or(isNull(aiReport.nextAttemptAt), lte(aiReport.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(aiReport.createdAt), asc(aiReport.id))
      .limit(room)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(aiReport)
      .set({
        nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        attempts: sql`${aiReport.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          aiReport.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

// ---------------------------------------------------------------------------------------------
// Generating

export type GenerateReportDeps = {
  db: Db;
  anthropic: AnthropicLike;
  model: string;
  /** Receives counts and error classes only, never fact sheet text, model output or keys. */
  logger: AiLogger;
  /** Overridden by tests. */
  now?: Date;
};

/** `superseded`: the row was no longer pending when the answer came, so nothing was stored. */
export type GenerateReportResult = 'ready' | 'skipped' | 'retry' | 'failed' | 'superseded';

/**
 * Rate limits, provider outages and connection failures or timeouts (which carry no status) are
 * retried by the sweep; anything else is final.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

/** A label that is safe to log: the HTTP status or the error class, never the message. */
function errorLabel(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `http ${status}`;
  return err instanceof Error ? err.name : 'unknown';
}

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

function usageOf(response: AiParseResult): Usage {
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
  };
}

/**
 * Generates the report of one claimed row. Every write is guarded by "still pending", so a row
 * someone else finished meanwhile is left alone.
 *
 *  - no income or spending in the month: `skipped`, no model call
 *  - ready: content, fact sheet, model and tokens stored, one household-wide notification
 *  - 429 or 5xx: still pending with a backoff of 5 minutes x 2^attempts (`attempts` was counted
 *    when the row was claimed), `failed` once {@link REPORT_MAX_ATTEMPTS} attempts failed
 *  - anything else: `failed` with a short `error_code`
 */
export async function generateReport(
  deps: GenerateReportDeps,
  row: AiReportRow,
): Promise<GenerateReportResult> {
  const { db, logger } = deps;
  const now = deps.now ?? new Date();
  const month = monthKey(row.month);
  const stillPending = and(eq(aiReport.id, row.id), eq(aiReport.status, 'pending'));

  const settle = (set: Partial<typeof aiReport.$inferInsert>) =>
    withHousehold(db, row.householdId, (tx) =>
      tx
        .update(aiReport)
        .set({ nextAttemptAt: null, updatedAt: new Date(), ...set })
        .where(stillPending)
        .returning({ id: aiReport.id }),
    );
  const fail = async (
    errorCode: string,
    extra: Partial<typeof aiReport.$inferInsert> = {},
  ): Promise<GenerateReportResult> => {
    await settle({ status: 'failed', errorCode, ...extra });
    return 'failed';
  };

  try {
    // Claims count as attempts, so a row that keeps coming back (a settle that keeps failing after
    // paid calls, a worker that keeps dying) stops here instead of calling the model again.
    if (row.attempts > REPORT_MAX_ATTEMPTS) {
      logger.warn(`ai report not generated: claimed ${row.attempts} times`);
      return await fail('internal_error');
    }
    const [settings] = await withHousehold(db, row.householdId, (tx) =>
      tx
        .select({ aiEnabled: householdSettings.aiEnabled })
        .from(householdSettings)
        .where(eq(householdSettings.householdId, row.householdId)),
    );
    if (!settings?.aiEnabled) return await fail('ai_disabled');

    const ctx: ServiceCtx = {
      db,
      householdId: row.householdId,
      userId: row.requestedBy ?? 'ai-report',
      role: 'owner',
    };
    const facts = await buildFactSheet(ctx, { month }, now);
    if (!hasActivity(facts)) {
      await settle({ status: 'skipped', facts, content: null, errorCode: null });
      return 'skipped';
    }

    const params: AiParseParams = {
      model: deps.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildReportSystemBlocks(row.locale),
      messages: [{ role: 'user', content: buildReportUserMessage(facts) }],
      output_config: { format: outputFormat() },
    };
    let response: AiParseResult;
    try {
      response = await deps.anthropic.messages.parse(params);
    } catch (err) {
      if (!isRetryable(err)) {
        logger.warn(`ai report failed: ${errorLabel(err)}`);
        return await fail('provider_error');
      }
      // the attempt was already counted when the row was claimed
      const attempts = row.attempts;
      const status = (err as { status?: number }).status;
      logger.warn(`ai report attempt ${attempts}/${REPORT_MAX_ATTEMPTS}: ${errorLabel(err)}`);
      if (attempts >= REPORT_MAX_ATTEMPTS) {
        return await fail(status === 429 ? 'rate_limited' : 'provider_unavailable');
      }
      await settle({
        nextAttemptAt: new Date(now.getTime() + BACKOFF_BASE_MS * 2 ** attempts),
      });
      return 'retry';
    }

    const usage = usageOf(response);
    logger.info(
      `ai report: ${usage.inputTokens} input and ${usage.outputTokens} output tokens ` +
        `(cache: ${usage.cacheWriteTokens ?? 0} written, ${usage.cacheReadTokens ?? 0} read)`,
    );
    const tokens = {
      model: deps.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    };
    if (response.stop_reason === 'refusal') return await fail('refused', tokens);
    const content = reportContentSchema.safeParse(response.parsed_output);
    if (!content.success) {
      logger.warn(`ai report unusable (${response.stop_reason ?? 'no output'})`);
      return await fail('invalid_output', tokens);
    }

    const done = await withHousehold(db, row.householdId, async (tx) => {
      const updated = await tx
        .update(aiReport)
        .set({
          status: 'ready',
          content: content.data,
          facts,
          errorCode: null,
          nextAttemptAt: null,
          updatedAt: new Date(),
          ...tokens,
        })
        .where(stillPending)
        .returning({ id: aiReport.id });
      if (updated.length === 0) return false;
      // The payload stays neutral: the month only, no figures. The dedupe key means a regenerate
      // replaces the report without notifying again.
      await createNotificationInTx(tx, {
        householdId: row.householdId,
        kind: 'ai_report_ready',
        payload: { month },
        dedupeKey: `ai_report:${month}`,
      });
      return true;
    });
    return done ? 'ready' : 'superseded';
  } catch (err) {
    logger.warn(`ai report failed: ${errorLabel(err)}`);
    await settle({ status: 'failed', errorCode: 'internal_error' }).catch((settleErr) =>
      logger.warn(`ai report could not be marked failed: ${errorLabel(settleErr)}`),
    );
    return 'failed';
  }
}
