import Anthropic from '@anthropic-ai/sdk';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@arfolio/db';
import {
  AI_MAX_RUN_MS,
  aiCategorise,
  findAiHouseholds,
  findHouseholdsWithAiWork,
  type AnthropicLike,
  type IntegrationConfig,
} from '@arfolio/services';
import {
  createAiGate,
  modelOf,
  type AnthropicClient,
  type AnthropicProvider,
  type GetConfig,
} from '../ai-gate.js';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';

/** Backstop for the minute check (a worker that missed it, a household just switched on). */
export const AI_SWEEP_CRON = '17 * * * *';
/**
 * New rows arrive by many routes (scheduled or manual sync, file import, a pending row booked,
 * the Trading 212 export): a cheap check every minute starts a run wherever rows are waiting.
 */
export const AI_CHECK_CRON = '* * * * *';
/** After a rate limit, outage or broken key the minute check leaves the household alone this long. */
export const AI_PAUSE_MS = 15 * 60_000;
/** Job expiry for a categorisation run: twice the run's time budget. */
export const AI_CATEGORISE_EXPIRE_SECONDS = (2 * AI_MAX_RUN_MS) / 1000;
const REQUEST_TIMEOUT_MS = 120_000;

const payload = z.strictObject({ householdId: z.string().min(1) });

export type AiJobDeps = { db: Db; anthropic: AnthropicLike | null; model: string };
/** What the `register*` functions take: the config and client are resolved at each run. */
export type AiRegisterDeps<C = AnthropicLike> = {
  db: Db;
  getConfig: GetConfig;
  getAnthropic: AnthropicProvider<C>;
};
export type SendWithOptions = (
  name: string,
  data: object,
  options: { singletonKey: string; retryLimit: number },
) => Promise<unknown>;

type AnthropicOptions = { maxRetries?: number; timeout?: number };

/** The SDK client for the configured key, or `null` when there is none (or it is unreadable). */
export function createAnthropic(
  cfg: Pick<IntegrationConfig, 'anthropicApiKey'>,
  opts: AnthropicOptions = {},
): AnthropicClient | null {
  const apiKey = cfg.anthropicApiKey.value;
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    timeout: opts.timeout ?? REQUEST_TIMEOUT_MS,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });
}

/**
 * `createAnthropic` that keeps its client while the key stays the same and builds a new one when
 * the key changes. The model is not part of the client: it is read from the config per request.
 */
export function createAnthropicMemo(opts: AnthropicOptions = {}): AnthropicProvider {
  let last: { apiKey: string; client: AnthropicClient } | undefined;
  return (cfg) => {
    const apiKey = cfg.anthropicApiKey.value;
    if (!apiKey) {
      last = undefined; // do not hold on to a removed key
      return null;
    }
    if (last?.apiKey === apiKey) return last.client;
    const client = createAnthropic(cfg, opts)!;
    last = { apiKey, client };
    return client;
  };
}

/** Households the minute check skips for a while (kept in memory: a restart clears it). */
export type AiPause = { pause(householdId: string): void; isPaused(householdId: string): boolean };

export function createAiPause(now: () => number = Date.now): AiPause {
  const until = new Map<string, number>();
  return {
    pause: (householdId) => void until.set(householdId, now() + AI_PAUSE_MS),
    isPaused(householdId) {
      const end = until.get(householdId);
      if (end === undefined) return false;
      if (end > now()) return true;
      until.delete(householdId);
      return false;
    },
  };
}

/**
 * Runs one categorisation for a household. Counts only are logged. A run stopped by a rate
 * limit, outage or broken key pauses the household for the minute check (the hourly sweep and
 * the next sync still try).
 */
export async function runAiCategoriseJob(
  deps: AiJobDeps,
  data: unknown,
  pause?: AiPause,
): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid ai-categorise job payload');
  const { householdId } = parsed.data;
  const result = await aiCategorise({ ...deps, logger: log }, { householdId });
  if (result.status === 'rate_limited') pause?.pause(householdId);
}

/**
 * Queues a pass for one household. The singleton key keeps at most one queued job per household
 * (the queue policy is `stately`: one queued and one active), so a burst of syncs collapses.
 * No retries: the hourly sweep picks up whatever a failed run left.
 */
export async function enqueueAiCategorise(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(QUEUES.aiCategorise, { householdId }, { singletonKey: householdId, retryLimit: 0 });
}

/** Queues a pass for every household that has AI on. Returns how many. */
export async function enqueueAiSweep(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findAiHouseholds(db);
  for (const householdId of households) {
    await enqueueAiCategorise(send, householdId);
  }
  return households.length;
}

/** Queues a run for every household with rows waiting for the AI, except paused ones. */
export async function enqueueAiCheck(
  db: Db,
  send: SendWithOptions,
  pause: AiPause,
): Promise<number> {
  const households = (await findHouseholdsWithAiWork(db)).filter((id) => !pause.isPaused(id));
  for (const householdId of households) {
    await enqueueAiCategorise(send, householdId);
  }
  return households.length;
}

/**
 * Registers the categorisation job, the minute check and the hourly sweep. Everything is
 * registered whether or not a key is configured: the config (key, model) is read at each run, so
 * a key saved later takes effect without a restart. While there is no key the runs do nothing.
 * Returns the function the sync job calls after each sync.
 */
export async function registerAiCategorise(
  boss: PgBoss,
  deps: AiRegisterDeps,
  tz: string,
): Promise<(householdId: string) => Promise<void>> {
  const { db } = deps;
  const open = createAiGate('AI categorisation', deps.getConfig, deps.getAnthropic);
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  // A run may take up to AI_MAX_RUN_MS plus one batch: the job must not expire meanwhile, or the
  // next check would start a second run for the household next to it. createQueue leaves an
  // existing queue as it is, so the expiry is also set with updateQueue.
  const expiry = { expireInSeconds: AI_CATEGORISE_EXPIRE_SECONDS };
  const pause = createAiPause();
  await registerJob(
    boss,
    QUEUES.aiCategorise,
    async (job) => {
      const ai = await open();
      if (!ai) return;
      await runAiCategoriseJob(
        { db, anthropic: ai.anthropic, model: modelOf(ai.cfg.models.categorisation) },
        job.data,
        pause,
      );
    },
    {},
    { policy: 'stately', ...expiry },
  );
  await boss.updateQueue(QUEUES.aiCategorise, expiry);
  await registerJob(boss, QUEUES.aiSweep, async () => {
    if (!(await open())) return;
    await enqueueAiSweep(db, send);
  });
  await registerJob(boss, QUEUES.aiCheck, async () => {
    if (!(await open())) return;
    await enqueueAiCheck(db, send, pause);
  });
  await boss.schedule(QUEUES.aiSweep, AI_SWEEP_CRON, null, { tz });
  // Every minute; pg-boss keeps one queued job per household, so a long run never piles up.
  await boss.schedule(QUEUES.aiCheck, AI_CHECK_CRON, null, { tz });
  return async (householdId) => {
    if (!(await open())) return;
    await enqueueAiCategorise(send, householdId);
  };
}
