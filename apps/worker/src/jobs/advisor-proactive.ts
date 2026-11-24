import type { PgBoss } from 'pg-boss';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdvisorLimits } from '@arfolio/core';
import { schema, withHousehold, type Db } from '@arfolio/db';
import {
  countCappedSince,
  detectEvents,
  findAiHouseholds,
  getMemberSettings,
  isAiAvailable,
  loadHouseholdSignals,
  loadSentState,
  notifyAdvisorMessage,
  type ServiceCtx,
} from '@arfolio/services';
import { runAdvisorTurn, type AdvisorModelClient } from '@arfolio/mcp/advisor';
import type { GetConfig } from '../ai-gate.js';
import { registerJob } from '../boss.js';
import { log } from '../log.js';
import { QUEUES } from '../queues.js';
import type { SendWithOptions } from './recurring-detect.js';

/** Daily at 09:00 (household time zone), after the morning sync, detection and budget alerts. */
export const ADVISOR_PROACTIVE_CRON = '0 9 * * *';

const WEEK_MS = 7 * 86_400_000;
/** Reads only: the household-wide figures need a context but no particular member. */
const SYSTEM_USER_ID = 'system:advisor-proactive';

const payload = z.strictObject({ householdId: z.string().min(1) });

export type AdvisorProactiveDeps = {
  db: Db;
  getConfig: GetConfig;
  /** The model client for an API key; tests inject a fake. */
  getClient: (apiKey: string) => AdvisorModelClient;
  limits: AdvisorLimits;
  /** The installation's product name (`BRAND_NAME`); the model is told it, code never hard-codes it. */
  brandName: string;
  now?: Date;
};

type Member = { userId: string; role: ServiceCtx['role'] };

const isRole = (role: string): role is ServiceCtx['role'] =>
  role === 'owner' || role === 'member' || role === 'viewer';

/**
 * One pass for one household: for each member who has proactive messages on, writes the messages
 * the events call for (see `detectEvents`) up to their weekly cap and notifies them. A failure
 * while serving one member is logged (ids and error class only) and does not stop the others.
 */
export async function runAdvisorProactive(
  deps: AdvisorProactiveDeps,
  householdId: string,
): Promise<void> {
  const cfg = await deps.getConfig();
  const apiKey = cfg.anthropicApiKey.value;
  const model = cfg.models.advisor.value;
  if (!isAiAvailable(cfg) || apiKey === undefined || model === undefined) return;

  const now = deps.now ?? new Date();
  const household = await withHousehold(deps.db, householdId, async (tx) => {
    const [settings] = await tx
      .select({
        aiEnabled: schema.householdSettings.aiEnabled,
        locale: schema.householdSettings.locale,
        currency: schema.householdSettings.currency,
      })
      .from(schema.householdSettings)
      .where(eq(schema.householdSettings.householdId, householdId));
    if (!settings?.aiEnabled) return null;
    // Every current member, viewers included: they chat with the advisor too.
    const members = await tx
      .select({ userId: schema.member.userId, role: schema.member.role })
      .from(schema.member)
      .where(eq(schema.member.organizationId, householdId))
      .orderBy(asc(schema.member.createdAt), asc(schema.member.id));
    return { ...settings, members };
  });
  if (!household) return;
  const members: Member[] = household.members.flatMap((m) =>
    isRole(m.role) ? [{ userId: m.userId, role: m.role }] : [],
  );

  const client = deps.getClient(apiKey);
  const ctxOf = (m: Member): ServiceCtx => ({
    db: deps.db,
    householdId,
    userId: m.userId,
    role: m.role,
  });

  // The figures are the household's, the same for every member: load them once, lazily.
  let signals: Awaited<ReturnType<typeof loadHouseholdSignals>> | undefined;
  for (const member of members) {
    const ctx = ctxOf(member);
    try {
      const settings = await getMemberSettings(ctx);
      if (!settings.proactiveEnabled) continue;
      signals ??= await loadHouseholdSignals(
        { ...ctx, userId: SYSTEM_USER_ID, role: 'owner' },
        { learningMonths: deps.limits.learningMonths, now },
      );
      const events = detectEvents({ ...signals, ...(await loadSentState(ctx)) });
      const cap = settings.weeklyCap ?? deps.limits.weeklyCap;
      const since = new Date(now.getTime() - WEEK_MS);
      for (const event of events) {
        if (event.countsTowardCap) {
          const sent = await withHousehold(deps.db, householdId, (tx) =>
            countCappedSince(tx, householdId, member.userId, since),
          );
          // Capped events come after the uncapped ones, so nothing later can still be sent.
          if (sent >= cap) break;
        }
        const result = await runAdvisorTurn(
          {
            ctx,
            client,
            model,
            limits: deps.limits,
            brandName: deps.brandName,
            locale: household.locale,
            currency: household.currency,
            now,
          },
          {
            kind: 'proactive',
            eventKey: event.key,
            eventFacts: event.facts,
            countsTowardCap: event.countsTowardCap,
          },
          () => {},
        );
        if ('skipped' in result) continue;
        await notifyAdvisorMessage(ctx, { messageId: result.messageId, eventKey: event.key });
      }
    } catch (err) {
      // Ids and the error class only: the message of a failed turn can carry figures.
      log.error(
        `advisor proactive failed for household ${householdId}, user ${member.userId}: ${
          err instanceof Error ? err.name : 'unknown error'
        }`,
      );
    }
  }
}

/** Runs one household's pass from a job's payload. */
export async function runAdvisorProactiveJob(
  deps: AdvisorProactiveDeps,
  data: unknown,
): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid advisor-proactive job payload');
  await runAdvisorProactive(deps, parsed.data.householdId);
}

/**
 * Queues a pass for one household. The singleton key keeps at most one queued job per household
 * (the queue policy is `stately`). No retries: tomorrow's run repeats it, and an event that failed
 * today left no message behind, so it is tried again then.
 */
export async function enqueueAdvisorProactive(
  send: SendWithOptions,
  householdId: string,
): Promise<void> {
  await send(
    QUEUES.advisorProactive,
    { householdId },
    { singletonKey: householdId, retryLimit: 0 },
  );
}

/** Queues a pass for every household that switched AI on. Returns how many. */
export async function enqueueAdvisorProactiveAll(db: Db, send: SendWithOptions): Promise<number> {
  const households = await findAiHouseholds(db);
  for (const householdId of households) await enqueueAdvisorProactive(send, householdId);
  return households.length;
}

/** Registers the per-household job and the daily schedule that feeds it. */
export async function registerAdvisorProactive(
  boss: PgBoss,
  deps: AdvisorProactiveDeps,
  tz: string,
  /** Called after each pass (queues push delivery for the notifications it created). */
  afterNotify: () => Promise<void> = async () => {},
): Promise<void> {
  const send: SendWithOptions = (name, data, options) => boss.send(name, data, options);
  await registerJob(
    boss,
    QUEUES.advisorProactive,
    async (job) => {
      await runAdvisorProactiveJob(deps, job.data);
      await afterNotify();
    },
    {},
    { policy: 'stately' },
  );
  await registerJob(boss, QUEUES.advisorProactiveScheduler, async () => {
    await enqueueAdvisorProactiveAll(deps.db, send);
  });
  await boss.schedule(QUEUES.advisorProactiveScheduler, ADVISOR_PROACTIVE_CRON, null, { tz });
}
