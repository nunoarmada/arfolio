import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { AI_VALUATION_KINDS, aiReadiness, minorDigits } from '@arfolio/core';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { MAX_AMOUNT_MINOR } from '../context.js';
import type { ValuationPortals } from '../integration-config.js';
import { refreshStoredSnapshotsInTx } from '../net-worth.js';
import { localDay } from '../sync.js';
import { errorLabel, type AiLogger } from './categorise.js';
import {
  buildValuationSystemBlocks,
  buildValuationUserMessage,
  estimateAnswerSchema,
  portalsFor,
  RECORD_ESTIMATE,
  recordEstimateTool,
  sourcesOnPortals,
  webTools,
} from './asset-valuation-prompt.js';

const { asset, assetValuation, householdSettings, organization } = schema;

/**
 * After a failed provider call (`api_error`) or an attempt that never settled, an asset is tried
 * again after this long. An answered failure waits for the next month or a new request.
 */
const RETRY_AFTER_MS = 12 * 3_600_000;
/** Recorded values given to the model as a sanity reference. */
const HISTORY_SIZE = 3;
/** `pause_turn` continuations per asset, after the first request. */
const MAX_RESUMES = 3;
const MAX_OUTPUT_TOKENS = 16_000;

/** The one SDK method this module uses, so tests can fake it without the network. */
export interface AnthropicCreateLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** An asset claimed for an estimate, with what the model is told about it. */
export type DueAsset = {
  householdId: string;
  assetId: string;
  kind: string;
  currency: string;
  details: Record<string, unknown> | null;
  /** When it was claimed: a request newer than this is kept when the asset settles. */
  claimedAt: Date;
  /** The last recorded values, newest first, in minor units. */
  history: Array<{ asOf: string; value: number; method: schema.ValuationMethod }>;
};

export type AssetEstimateResult = 'ready' | 'insufficient_data' | 'no_answer' | 'api_error';

export type EstimateAssetDeps = {
  db: Db;
  anthropic: AnthropicCreateLike;
  model: string;
  /** Listing portals the web tools are restricted to (`cfg.valuationPortals`). */
  portals: ValuationPortals;
  /** Receives counts and result codes only, never asset details or the model's answer. */
  logger: AiLogger;
  now: Date;
  /** Fallback time zone for a household without settings. */
  tz: string;
};

const firstOfMonth = (day: string) => `${day.slice(0, 8)}01`;

async function householdTimeZone(db: Db, householdId: string): Promise<string | null> {
  const [settings] = await withHousehold(db, householdId, (tx) =>
    tx
      .select({ timezone: householdSettings.timezone })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId)),
  );
  return settings?.timezone ?? null;
}

// ---------------------------------------------------------------------------------------------
// Claiming (worker side, across households: RLS needs one household at a time)

/**
 * Claims up to `limit` assets due for an AI estimate, household by household. Candidates: AI on,
 * not archived, not linked to an account, of an AI kind, in a household with AI on. Due when:
 *  - asked for after the last attempt (or a request left unsettled by an attempt 12 hours ago), or
 *  - without an `ai` or `manual` value since the first day of the current month in the household
 *    time zone, and not attempted this month, or last attempted more than 12 hours ago with a
 *    provider failure (`api_error`) or without settling. A failure the model answered
 *    (`insufficient_data`, `no_answer`) settles the month.
 * Rows are locked with
 * `for update skip locked` and stamped `ai_attempted_at = now` in the same transaction, so a
 * concurrent sweep skips them and, once committed, no longer sees them as due. `tz` is the
 * installation default; a household with AI on always has settings, so its own zone is used.
 */
export async function claimDueAssetValuations(
  db: Db,
  opts: { now: Date; limit: number; tz: string; logger?: AiLogger },
): Promise<DueAsset[]> {
  const households = await db
    .select({ id: organization.id })
    .from(organization)
    .orderBy(asc(organization.id));
  const claimed: DueAsset[] = [];
  for (const { id } of households) {
    const room = opts.limit - claimed.length;
    if (room <= 0) break;
    try {
      claimed.push(...(await claimHousehold(db, id, room, opts.now)));
    } catch (err) {
      // One household failing must not stop the sweep: its error class is logged, never its id.
      opts.logger?.warn(`ai valuation sweep: a household was skipped (${errorLabel(err)})`);
    }
  }
  return claimed;
}

function claimHousehold(db: Db, householdId: string, room: number, now: Date): Promise<DueAsset[]> {
  return withHousehold(db, householdId, async (tx) => {
    const [settings] = await tx
      .select({ aiEnabled: householdSettings.aiEnabled, timezone: householdSettings.timezone })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    if (!settings?.aiEnabled) return [];
    const monthStart = firstOfMonth(localDay(now, settings.timezone));
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);

    const valuedThisMonth = tx
      .select({ id: assetValuation.id })
      .from(assetValuation)
      .where(
        and(
          eq(assetValuation.householdId, householdId),
          eq(assetValuation.assetId, asset.id),
          inArray(assetValuation.method, ['ai', 'manual']),
          gte(assetValuation.asOf, monthStart),
        ),
      );
    const requested = and(
      isNotNull(asset.aiRequestedAt),
      or(
        isNull(asset.aiAttemptedAt),
        gt(asset.aiRequestedAt, asset.aiAttemptedAt),
        lt(asset.aiAttemptedAt, retryBefore),
      ),
    );
    const monthly = and(
      notExists(valuedThisMonth),
      or(
        isNull(asset.aiAttemptedAt),
        sql`(${asset.aiAttemptedAt} at time zone ${settings.timezone})::date < ${monthStart}::date`,
        and(
          lt(asset.aiAttemptedAt, retryBefore),
          or(isNull(asset.aiLastError), eq(asset.aiLastError, 'api_error')),
        ),
      ),
    );
    const due = await tx
      .select({ id: asset.id })
      .from(asset)
      .where(
        and(
          eq(asset.householdId, householdId),
          eq(asset.aiValuation, true),
          eq(asset.archived, false),
          isNull(asset.disposedOn),
          isNull(asset.accountId),
          inArray(asset.kind, [...AI_VALUATION_KINDS]),
          or(requested, monthly),
        ),
      )
      .orderBy(asc(asset.aiRequestedAt), asc(asset.id))
      .limit(room)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];

    const ids = due.map((d) => d.id);
    const rows = await tx
      .update(asset)
      .set({ aiAttemptedAt: now })
      .where(and(eq(asset.householdId, householdId), inArray(asset.id, ids)))
      .returning({
        id: asset.id,
        kind: asset.kind,
        currency: asset.currency,
        details: asset.details,
      });

    const values = await tx
      .select({
        assetId: assetValuation.assetId,
        asOf: assetValuation.asOf,
        value: assetValuation.value,
        method: assetValuation.method,
      })
      .from(assetValuation)
      .where(and(eq(assetValuation.householdId, householdId), inArray(assetValuation.assetId, ids)))
      .orderBy(desc(assetValuation.asOf));

    return rows.map((row) => ({
      householdId,
      assetId: row.id,
      kind: row.kind,
      currency: row.currency,
      details: row.details ?? null,
      claimedAt: now,
      history: values
        .filter((v) => v.assetId === row.id)
        .slice(0, HISTORY_SIZE)
        .map(({ asOf, value, method }) => ({ asOf, value, method })),
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// Estimating

type Outcome = { kind: 'answer'; message: Anthropic.Message } | { kind: 'api_error'; err: unknown };

/** One request, resumed with the assistant content so far while the turn pauses, at most 3 times. */
async function ask(
  anthropic: AnthropicCreateLike,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<{ outcome: Outcome; calls: number; searches: number }> {
  let calls = 0;
  let searches = 0;
  let messages = params.messages;
  try {
    for (;;) {
      const message = await anthropic.messages.create({ ...params, messages });
      calls += 1;
      searches += message.usage.server_tool_use?.web_search_requests ?? 0;
      if (message.stop_reason !== 'pause_turn' || calls > MAX_RESUMES) {
        return { outcome: { kind: 'answer', message }, calls, searches };
      }
      // Each resume carries every paused turn so far, as the SDK tool runner does.
      messages = [...messages, { role: 'assistant', content: message.content }];
    }
  } catch (err) {
    return { outcome: { kind: 'api_error', err }, calls, searches };
  }
}

/** The `record_estimate` input of an answer, or null when the model never called it. */
function recordedInput(message: Anthropic.Message): unknown {
  if (message.stop_reason === 'refusal') return null;
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === RECORD_ESTIMATE,
  );
  return block ? block.input : null;
}

/**
 * Major units to minor units (`factor` = 10 ^ the currency's minor digits), or null when not a
 * storable amount.
 */
function toMinor(major: number, factor: number): number | null {
  const minor = Math.round(major * factor);
  return Number.isFinite(minor) && minor >= 0 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

export type AssetFailure = Exclude<AssetEstimateResult, 'ready'>;

/** The request once a claimed asset settles: kept only when it came in after the claim. */
const requestAfterSettling = (due: DueAsset) =>
  sql`case when ${asset.aiRequestedAt} > ${due.claimedAt.toISOString()}::timestamptz then ${asset.aiRequestedAt} end`;

/** Settles a claimed asset as failed with `code`; a request newer than the claim is kept. */
export async function markAssetValuationFailed(
  db: Db,
  due: DueAsset,
  code: AssetFailure,
): Promise<void> {
  await withHousehold(db, due.householdId, (tx) =>
    tx
      .update(asset)
      .set({ aiLastError: code, aiRequestedAt: requestAfterSettling(due) })
      .where(and(eq(asset.id, due.assetId), eq(asset.householdId, due.householdId))),
  );
}

/**
 * Estimates the value of one claimed asset and settles it.
 *
 *  - details not enough for an estimate (`aiReadiness`): `insufficient_data`, no model call
 *  - a value of another method already recorded for today in the household time zone: `ready`
 *    without a model call or a write (that value stands for the month)
 *  - the model calls `record_estimate` with a usable value: an `ai` valuation for today, request
 *    and error cleared, stored snapshots refreshed: `ready`. Nothing is written when the asset was
 *    switched off, archived or linked meanwhile.
 *  - `value: null`: `insufficient_data`; refusal, no call, or an unusable answer: `no_answer`; the
 *    provider call failing: `api_error`. The code is stored in `ai_last_error`.
 * Settling clears the request unless a newer one came in after the claim.
 */
export async function estimateAssetValue(
  deps: EstimateAssetDeps,
  due: DueAsset,
): Promise<AssetEstimateResult> {
  const { db, logger, now } = deps;
  const today = localDay(now, (await householdTimeZone(db, due.householdId)) ?? deps.tz);
  const thisAsset = and(eq(asset.id, due.assetId), eq(asset.householdId, due.householdId));
  const settledRequest = requestAfterSettling(due);

  const fail = async (code: AssetFailure) => {
    await markAssetValuationFailed(db, due, code);
    logger.info(`ai valuation: ${code}`);
    return code;
  };

  if (!aiReadiness(due.kind, due.details).eligible) return fail('insufficient_data');

  const [recordedToday] = await withHousehold(db, due.householdId, (tx) =>
    tx
      .select({ id: assetValuation.id })
      .from(assetValuation)
      .where(
        and(
          eq(assetValuation.householdId, due.householdId),
          eq(assetValuation.assetId, due.assetId),
          eq(assetValuation.asOf, today),
          ne(assetValuation.method, 'ai'),
        ),
      ),
  );
  if (recordedToday) {
    await withHousehold(db, due.householdId, (tx) =>
      tx.update(asset).set({ aiLastError: null, aiRequestedAt: settledRequest }).where(thisAsset),
    );
    logger.info('ai valuation: a value is already recorded for today');
    return 'ready';
  }

  // ISO 4217 minor digits: 2 for EUR, 0 for JPY, 3 for KWD.
  const factor = 10 ** minorDigits(due.currency);
  const portals = portalsFor(due.kind, due.details, deps.portals);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: deps.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: buildValuationSystemBlocks(),
    messages: [
      {
        role: 'user',
        content: buildValuationUserMessage({
          kind: due.kind,
          details: due.details,
          currency: due.currency,
          today,
          history: due.history.map((h) => ({ ...h, value: h.value / factor })),
        }),
      },
    ],
    tools: [...webTools(portals), recordEstimateTool],
    tool_choice: { type: 'auto' },
    output_config: { effort: 'medium' },
  };

  const { outcome, calls, searches } = await ask(deps.anthropic, params);
  logger.info(`ai valuation: ${calls} request(s), ${searches} web search(es)`);
  if (outcome.kind === 'api_error') {
    logger.warn(`ai valuation request failed: ${errorLabel(outcome.err)}`);
    return fail('api_error');
  }

  const input = recordedInput(outcome.message);
  if (input === null) return fail('no_answer');
  const parsed = estimateAnswerSchema.safeParse(input);
  if (!parsed.success) return fail('no_answer');
  const answer = parsed.data;
  if (answer.value === null) return fail('insufficient_data');
  const value = toMinor(answer.value, factor);
  const low = toMinor(answer.low ?? answer.value, factor);
  const high = toMinor(answer.high ?? answer.value, factor);
  if (value === null || value === 0 || low === null || high === null) return fail('no_answer');

  const row = {
    value,
    method: 'ai' as const,
    note: answer.rationale || null,
    estimate: {
      low,
      high,
      confidence: answer.confidence,
      sources: sourcesOnPortals(answer.sources, portals),
    },
  };
  const written = await withHousehold(db, due.householdId, async (tx) => {
    // Still an AI-valued, live, unlinked asset: otherwise the answer is dropped.
    const [settled] = await tx
      .update(asset)
      .set({ aiRequestedAt: settledRequest, aiLastError: null })
      .where(
        and(
          thisAsset,
          eq(asset.aiValuation, true),
          eq(asset.archived, false),
          isNull(asset.disposedOn),
          isNull(asset.accountId),
        ),
      )
      .returning({ id: asset.id });
    if (!settled) return false;
    await tx
      .insert(assetValuation)
      .values({ householdId: due.householdId, assetId: due.assetId, asOf: today, ...row })
      .onConflictDoUpdate({
        target: [assetValuation.assetId, assetValuation.asOf],
        set: row,
        setWhere: eq(assetValuation.method, 'ai'),
      });
    await refreshStoredSnapshotsInTx(tx, due.householdId, today, now);
    return true;
  });
  logger.info(written ? 'ai valuation: ready' : 'ai valuation: dropped, asset changed meanwhile');
  return 'ready';
}
