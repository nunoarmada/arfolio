import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from '../context.js';
import { resolveProposalDisplay, type ProposalDisplay } from './proposal-display.js';

const { advisorMessage, advisorProposal, advisorNote, advisorMemberSettings, householdSettings } =
  schema;

export type AdvisorMessage = typeof advisorMessage.$inferSelect;
export type AdvisorProposal = typeof advisorProposal.$inferSelect;
export type AdvisorNote = typeof advisorNote.$inferSelect;
/** A proposal as it leaves the service: the public basis, and the names the card shows. */
export type AdvisorProposalView = AdvisorProposal & { display: ProposalDisplay | null };
export type AdvisorMessageView = AdvisorMessage & { proposals: AdvisorProposalView[] };
export type AdvisorMemberSettings = { proactiveEnabled: boolean; weeklyCap: number | null };

export const MAX_ADVISOR_NOTES = 30;
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
/** A pending message older than this belongs to a turn that died; it is shown as failed. */
const PENDING_TTL_MS = 10 * 60_000;

const noteText = z.string().trim().min(1).max(500);
const settingsInput = z.strictObject({
  proactiveEnabled: z.boolean(),
  weeklyCap: z.number().int().min(0).max(14).nullable(),
});

/**
 * The basis as UI and model may see it: the judged figures without the internal `amountsSnapshot`
 * (which only `applyProposal` reads, from the raw row). `null` when nothing else remains.
 */
export function publicBasis(basis: unknown): unknown {
  if (basis === null || typeof basis !== 'object' || Array.isArray(basis)) return basis ?? null;
  const rest = { ...(basis as Record<string, unknown>) };
  delete rest.amountsSnapshot;
  return Object.keys(rest).length > 0 ? rest : null;
}

/** A stored proposal as it leaves the service: the public basis, and what its card must show. */
async function toProposalView(tx: Tx, row: AdvisorProposal): Promise<AdvisorProposalView> {
  return {
    ...row,
    basis: publicBasis(row.basis),
    display: await resolveProposalDisplay(tx, row.householdId, row.kind, row.payload),
  };
}

/** Conversations are private per member: every statement filters household AND user. */
const mine = <T extends typeof advisorMessage | typeof advisorProposal | typeof advisorNote>(
  table: T,
  ctx: Pick<ServiceCtx, 'householdId' | 'userId'>,
) => and(eq(table.householdId, ctx.householdId), eq(table.userId, ctx.userId));

/** Appends a message; resolves `null` when `eventKey` was already used by this member. */
export async function appendMessage(
  ctx: ServiceCtx,
  m: {
    role: 'user' | 'assistant';
    origin: 'chat' | 'proactive';
    text: string;
    eventKey?: string;
    countsTowardCap?: boolean;
    status?: 'pending' | 'complete' | 'failed';
  },
): Promise<AdvisorMessage | null> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .insert(advisorMessage)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        role: m.role,
        origin: m.origin,
        text: m.text,
        eventKey: m.eventKey ?? null,
        countsTowardCap: m.countsTowardCap ?? false,
        ...(m.status ? { status: m.status } : {}),
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });
}

export async function finishMessage(
  ctx: ServiceCtx,
  id: string,
  result: { text: string; status: 'complete' | 'failed' },
): Promise<boolean> {
  assertUuid(id, 'Message');
  const updated = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .update(advisorMessage)
      .set({ text: result.text, status: result.status })
      .where(
        and(
          eq(advisorMessage.id, id),
          eq(advisorMessage.status, 'pending'),
          mine(advisorMessage, ctx),
        ),
      )
      .returning({ id: advisorMessage.id }),
  );
  return updated.length > 0;
}

export async function deleteMessage(ctx: ServiceCtx, id: string): Promise<void> {
  assertUuid(id, 'Message');
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.delete(advisorMessage).where(and(eq(advisorMessage.id, id), mine(advisorMessage, ctx))),
  );
}

/** Drops the proposals a message holds (a turn that failed must leave none behind). */
export async function deleteProposalsForMessage(ctx: ServiceCtx, messageId: string): Promise<void> {
  assertUuid(messageId, 'Message');
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .delete(advisorProposal)
      .where(and(eq(advisorProposal.messageId, messageId), mine(advisorProposal, ctx))),
  );
}

/** Newest first. `before` is the id of the oldest message the caller already holds. */
export async function listMessages(
  ctx: ServiceCtx,
  opts: { before?: string; limit?: number },
): Promise<AdvisorMessageView[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE), 1), MAX_PAGE);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    let cursor = undefined;
    if (opts.before !== undefined) {
      assertUuid(opts.before, 'Message');
      const [anchor] = await tx
        .select({ id: advisorMessage.id })
        .from(advisorMessage)
        .where(and(eq(advisorMessage.id, opts.before), mine(advisorMessage, ctx)));
      if (!anchor) throw new NotFoundError('Message');
      // Compared in SQL: a JS Date would truncate the microseconds of created_at.
      cursor = sql`(${advisorMessage.createdAt}, ${advisorMessage.id}) < (select a.created_at, a.id from advisor_message a where a.id = ${opts.before})`;
    }
    const rows = await tx
      .select()
      .from(advisorMessage)
      .where(and(mine(advisorMessage, ctx), cursor))
      .orderBy(desc(advisorMessage.createdAt), desc(advisorMessage.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const proposals = await tx
      .select()
      .from(advisorProposal)
      .where(
        and(
          mine(advisorProposal, ctx),
          inArray(
            advisorProposal.messageId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(advisorProposal.createdAt), asc(advisorProposal.id));
    const views = new Map<string, AdvisorProposalView>();
    for (const p of proposals) views.set(p.id, await toProposalView(tx, p));
    const expiry = Date.now() - PENDING_TTL_MS;
    return rows.map((r) => ({
      ...r,
      status: r.status === 'pending' && r.createdAt.getTime() < expiry ? 'failed' : r.status,
      proposals: proposals.filter((p) => p.messageId === r.id).map((p) => views.get(p.id)!),
    }));
  });
}

export async function saveProposal(
  ctx: ServiceCtx,
  p: {
    messageId: string;
    kind: schema.AdvisorProposalKind;
    payload: unknown;
    basis: unknown;
    targetUpdatedAt: Date | null;
  },
): Promise<AdvisorProposalView> {
  assertUuid(p.messageId, 'Message');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [owned] = await tx
      .select({ id: advisorMessage.id })
      .from(advisorMessage)
      .where(and(eq(advisorMessage.id, p.messageId), mine(advisorMessage, ctx)));
    if (!owned) throw new NotFoundError('Message');
    const [row] = await tx
      .insert(advisorProposal)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        messageId: p.messageId,
        kind: p.kind,
        payload: p.payload ?? {},
        basis: p.basis ?? null,
        targetUpdatedAt: p.targetUpdatedAt,
      })
      .returning();
    return toProposalView(tx, row!);
  });
}

/** Another member's proposal is "not found", never forbidden: its existence stays private. */
export async function getProposal(ctx: ServiceCtx, id: string): Promise<AdvisorProposalView> {
  assertUuid(id, 'Proposal');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(advisorProposal)
      .where(and(eq(advisorProposal.id, id), mine(advisorProposal, ctx)));
    if (!row) throw new NotFoundError('Proposal');
    return toProposalView(tx, row);
  });
}

export async function listNotes(ctx: ServiceCtx): Promise<AdvisorNote[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(advisorNote)
      .where(mine(advisorNote, ctx))
      .orderBy(asc(advisorNote.createdAt), asc(advisorNote.id)),
  );
}

export async function addNote(ctx: ServiceCtx, text: string): Promise<AdvisorNote> {
  const value = parseInput(noteText, text);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    // Serialise concurrent adds of one member so the cap cannot be overshot.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`advisor_note:${ctx.householdId}:${ctx.userId}`}))`,
    );
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(advisorNote)
      .where(mine(advisorNote, ctx));
    if (n >= MAX_ADVISOR_NOTES) {
      throw new ValidationError(`At most ${MAX_ADVISOR_NOTES} notes`, [], 'note_limit', {
        limit: MAX_ADVISOR_NOTES,
      });
    }
    const [row] = await tx
      .insert(advisorNote)
      .values({ householdId: ctx.householdId, userId: ctx.userId, text: value })
      .returning();
    return row!;
  });
}

export async function deleteNote(ctx: ServiceCtx, id: string): Promise<void> {
  assertUuid(id, 'Note');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const removed = await tx
      .delete(advisorNote)
      .where(and(eq(advisorNote.id, id), mine(advisorNote, ctx)))
      .returning({ id: advisorNote.id });
    if (removed.length === 0) throw new NotFoundError('Note');
  });
}

/** Deletes the member's messages, proposals and notes; goals and settings stay. */
export async function clearHistory(ctx: ServiceCtx): Promise<void> {
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await tx.delete(advisorProposal).where(mine(advisorProposal, ctx));
    await tx.delete(advisorMessage).where(mine(advisorMessage, ctx));
    await tx.delete(advisorNote).where(mine(advisorNote, ctx));
  });
}

export async function getMemberSettings(ctx: ServiceCtx): Promise<AdvisorMemberSettings> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(advisorMemberSettings)
      .where(
        and(
          eq(advisorMemberSettings.householdId, ctx.householdId),
          eq(advisorMemberSettings.userId, ctx.userId),
        ),
      );
    return { proactiveEnabled: row?.proactiveEnabled ?? true, weeklyCap: row?.weeklyCap ?? null };
  });
}

export async function saveMemberSettings(ctx: ServiceCtx, s: AdvisorMemberSettings): Promise<void> {
  const value = parseInput(settingsInput, s);
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .insert(advisorMemberSettings)
      .values({ householdId: ctx.householdId, userId: ctx.userId, ...value })
      .onConflictDoUpdate({
        target: [advisorMemberSettings.householdId, advisorMemberSettings.userId],
        set: value,
      }),
  );
}

/** Everything one user has in one household; used when the membership ends. */
export async function deleteAdvisorDataForUser(
  tx: Tx,
  householdId: string,
  userId: string,
): Promise<void> {
  const who = { householdId, userId };
  await tx.delete(advisorProposal).where(mine(advisorProposal, who));
  await tx.delete(advisorMessage).where(mine(advisorMessage, who));
  await tx.delete(advisorNote).where(mine(advisorNote, who));
  await tx
    .delete(advisorMemberSettings)
    .where(
      and(
        eq(advisorMemberSettings.householdId, householdId),
        eq(advisorMemberSettings.userId, userId),
      ),
    );
}

/** Proactive messages that count toward the weekly cap, created at or after `since`. */
export async function countCappedSince(
  tx: Tx,
  householdId: string,
  userId: string,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(advisorMessage)
    .where(
      and(
        mine(advisorMessage, { householdId, userId }),
        eq(advisorMessage.countsTowardCap, true),
        sql`${advisorMessage.createdAt} >= ${since}`,
      ),
    );
  return row?.n ?? 0;
}

/** Chat messages the member sent since local midnight (household timezone) at `now`. */
async function countMessagesToday(
  tx: Tx,
  ctx: ServiceCtx,
  now: Date,
  /** Without the upper bound a claim also counts rows stored after `now` was read (concurrent claims). */
  bounded = true,
): Promise<number> {
  const [settings] = await tx
    .select({ timezone: householdSettings.timezone })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, ctx.householdId));
  const tz = settings?.timezone ?? 'UTC';
  const nowTs = now.toISOString();
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(advisorMessage)
    .where(
      and(
        mine(advisorMessage, ctx),
        eq(advisorMessage.role, 'user'),
        eq(advisorMessage.origin, 'chat'),
        sql`${advisorMessage.createdAt} >= (date_trunc('day', ${nowTs}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
        bounded ? sql`${advisorMessage.createdAt} <= ${nowTs}::timestamptz` : undefined,
      ),
    );
  return row?.n ?? 0;
}

export async function messagesToday(ctx: ServiceCtx, now: Date): Promise<number> {
  return withHousehold(ctx.db, ctx.householdId, (tx) => countMessagesToday(tx, ctx, now));
}

/**
 * Starts a chat turn atomically per member: under an advisory lock it checks the daily cap and
 * that no recent answer is still pending (one turn at a time), then stores the member's message and a pending answer that holds the turn.
 * Checking and storing in separate steps would let concurrent requests slip past the cap.
 */
export async function claimChatTurn(
  ctx: ServiceCtx,
  opts: { text: string; dailyLimit: number; now: Date },
): Promise<
  { userMessageId: string; assistantMessageId: string } | { refused: 'daily_limit' | 'busy' }
> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`advisor_chat:${ctx.householdId}:${ctx.userId}`}))`,
    );
    if ((await countMessagesToday(tx, ctx, opts.now, false)) >= opts.dailyLimit) {
      return { refused: 'daily_limit' as const };
    }
    const [pending] = await tx
      .select({ id: advisorMessage.id })
      .from(advisorMessage)
      .where(
        and(
          mine(advisorMessage, ctx),
          eq(advisorMessage.role, 'assistant'),
          eq(advisorMessage.status, 'pending'),
          gte(advisorMessage.createdAt, new Date(opts.now.getTime() - PENDING_TTL_MS)),
        ),
      )
      .limit(1);
    if (pending) return { refused: 'busy' as const };
    const [row] = await tx
      .insert(advisorMessage)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        role: 'user',
        origin: 'chat',
        text: opts.text,
      })
      .returning({ id: advisorMessage.id });
    // The pending answer is what makes a second claim `busy`: it must exist before the lock ends.
    const [answer] = await tx
      .insert(advisorMessage)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        role: 'assistant',
        origin: 'chat',
        text: '',
        status: 'pending',
        // now() is the transaction start, equal to the member message's: the answer must sort after it.
        createdAt: sql`clock_timestamp()`,
      })
      .returning({ id: advisorMessage.id });
    return { userMessageId: row!.id, assistantMessageId: answer!.id };
  });
}
