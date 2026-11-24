import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  addNote,
  appendMessage,
  claimChatTurn,
  clearHistory,
  countCappedSince,
  deleteAdvisorDataForUser,
  deleteMessage,
  deleteNote,
  deleteProposalsForMessage,
  finishMessage,
  getMemberSettings,
  getProposal,
  listMessages,
  listNotes,
  messagesToday,
  NotFoundError,
  saveMemberSettings,
  saveProposal,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

describe('advisor store', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** Two members of one household; the FK to "user" needs real user rows. */
  async function pair(): Promise<{ a: ServiceCtx; b: ServiceCtx }> {
    const base = await t.household({ currency: 'EUR' });
    const mk = async (label: string): Promise<ServiceCtx> => {
      const id = `u_${randomUUID()}`;
      await t.owner
        .insert(schema.user)
        .values({ id, name: label, email: `${id}@example.com`, createdAt: new Date() });
      return { ...base, userId: id };
    };
    return { a: await mk('A'), b: await mk('B') };
  }
  const say = (
    ctx: ServiceCtx,
    text: string,
    extra: Partial<Parameters<typeof appendMessage>[1]> = {},
  ) => appendMessage(ctx, { role: 'user', origin: 'chat', text, ...extra });

  it("deletes the proposals of one message and nobody else's", async () => {
    const { a, b } = await pair();
    const mine = await say(a, 'hello');
    const other = await say(a, 'again');
    const draft = (messageId: string) => ({
      messageId,
      kind: 'rule_create' as const,
      payload: {},
      basis: null,
      targetUpdatedAt: null,
    });
    await saveProposal(a, draft(mine!.id));
    const kept = await saveProposal(a, draft(other!.id));
    await deleteProposalsForMessage(b, mine!.id);
    expect((await listMessages(a, {})).flatMap((m) => m.proposals)).toHaveLength(2);
    await deleteProposalsForMessage(a, mine!.id);
    const left = (await listMessages(a, {})).flatMap((m) => m.proposals);
    expect(left.map((p) => p.id)).toEqual([kept.id]);
    await expect(deleteProposalsForMessage(a, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps conversations private between members', async () => {
    const { a, b } = await pair();
    const msg = await say(a, 'hello');
    const proposal = await saveProposal(a, {
      messageId: msg!.id,
      kind: 'goal_create',
      payload: { name: 'Trip' },
      basis: null,
      targetUpdatedAt: null,
    });
    expect(await listMessages(b, {})).toEqual([]);
    await expect(getProposal(b, proposal.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProposal(a, proposal.id)).resolves.toMatchObject({ id: proposal.id });
    await expect(getProposal(a, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never returns the internal amounts snapshot in the proposal basis', async () => {
    const { a } = await pair();
    const msg = await say(a, 'hello');
    const save = (basis: unknown) =>
      saveProposal(a, {
        messageId: msg!.id,
        kind: 'budget_line_amount',
        payload: {},
        basis,
        targetUpdatedAt: null,
      });
    const figures = { months: 3, min: 1, max: 5, median: 3, currency: 'EUR' };
    const mixed = await save({ ...figures, amountsSnapshot: [1, 2, 3] });
    const onlySnapshot = await save({ amountsSnapshot: [1, 2, 3] });
    const plain = await save(figures);
    expect(mixed.basis).toEqual(figures);
    expect(onlySnapshot.basis).toBeNull();
    const [view] = await listMessages(a, {});
    const byId = new Map(view!.proposals.map((p) => [p.id, p.basis]));
    expect(byId.get(mixed.id)).toEqual(figures);
    expect(byId.get(onlySnapshot.id)).toBeNull();
    expect(byId.get(plain.id)).toEqual(figures);
    expect((await getProposal(a, mixed.id)).basis).toEqual(figures);
    // Stored raw: apply still compares against the snapshot.
    const [raw] = await withHousehold(a.db, a.householdId, (tx) =>
      tx.select().from(schema.advisorProposal).where(eq(schema.advisorProposal.id, mixed.id)),
    );
    expect(raw!.basis).toEqual({ ...figures, amountsSnapshot: [1, 2, 3] });
  });

  it('dedupes proactive messages by event key', async () => {
    const { a } = await pair();
    const base = {
      role: 'assistant',
      origin: 'proactive',
      text: 'Heads up',
      eventKey: 'k1',
    } as const;
    expect(await appendMessage(a, base)).toMatchObject({ eventKey: 'k1' });
    expect(await appendMessage(a, base)).toBeNull();
  });

  it('accepts the same event key for a different member', async () => {
    const { a, b } = await pair();
    const base = {
      role: 'assistant',
      origin: 'proactive',
      text: 'Hi',
      eventKey: 'shared',
    } as const;
    expect(await appendMessage(a, base)).not.toBeNull();
    expect(await appendMessage(b, base)).not.toBeNull();
  });

  it('pages without skipping rows that share a millisecond', async () => {
    const { a } = await pair();
    const ids: string[] = [];
    for (const text of ['m1', 'm2', 'm3']) ids.push((await say(a, text))!.id);
    // Same millisecond, different microseconds: a JS Date cursor cannot tell them apart.
    for (const [i, id] of ids.entries()) {
      await t.owner.execute(
        sql`update advisor_message set created_at = '2026-03-01T10:00:00.123000Z'::timestamptz + ${i * 100} * interval '1 microsecond' where id = ${id}`,
      );
    }
    const first = await listMessages(a, { limit: 1 });
    const second = await listMessages(a, { before: first[0]!.id, limit: 1 });
    const third = await listMessages(a, { before: second[0]!.id, limit: 1 });
    expect([first, second, third].map((p) => p[0]!.text)).toEqual(['m3', 'm2', 'm1']);
  });

  it('lists newest first with proposals, paged by before', async () => {
    const { a } = await pair();
    const first = await say(a, 'one');
    const second = await say(a, 'two');
    const third = await say(a, 'three');
    await saveProposal(a, {
      messageId: second!.id,
      kind: 'rule_create',
      payload: {},
      basis: { why: 'x' },
      targetUpdatedAt: null,
    });
    const page = await listMessages(a, { limit: 2 });
    expect(page.map((m) => m.text)).toEqual(['three', 'two']);
    expect(page[1]!.proposals).toHaveLength(1);
    expect(page[0]!.proposals).toEqual([]);
    const older = await listMessages(a, { before: page[1]!.id, limit: 2 });
    expect(older.map((m) => m.id)).toEqual([first!.id]);
    expect(third!.id).toBe(page[0]!.id);
  });

  it('finishes, deletes and expires pending messages', async () => {
    const { a } = await pair();
    const msg = await appendMessage(a, {
      role: 'assistant',
      origin: 'chat',
      text: '',
      status: 'pending',
    });
    expect(await finishMessage(a, msg!.id, { text: 'done', status: 'complete' })).toBe(true);
    // Only a pending message can be finished: a second call changes nothing.
    expect(await finishMessage(a, msg!.id, { text: 'again', status: 'failed' })).toBe(false);
    expect((await listMessages(a, {}))[0]).toMatchObject({ text: 'done', status: 'complete' });

    const stale = await appendMessage(a, {
      role: 'assistant',
      origin: 'chat',
      text: '',
      status: 'pending',
    });
    await t.owner
      .update(schema.advisorMessage)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.advisorMessage.id, stale!.id));
    const seen = await listMessages(a, {});
    expect(seen.find((m) => m.id === stale!.id)?.status).toBe('failed');

    await deleteMessage(a, msg!.id);
    expect((await listMessages(a, {})).some((m) => m.id === msg!.id)).toBe(false);
  });

  it('refuses the 31st note', async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 30; i++) await addNote(a, `note ${i}`);
    await expect(addNote(a, 'one too many')).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'note_limit',
    });
    await expect(addNote(a, 'x')).rejects.toBeInstanceOf(ValidationError);
    await expect(addNote(b, 'mine')).resolves.toMatchObject({ text: 'mine' });
    const notes = await listNotes(a);
    expect(notes).toHaveLength(30);
    await deleteNote(a, notes[0]!.id);
    expect(await listNotes(a)).toHaveLength(29);
    await expect(deleteNote(b, notes[1]!.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('clearHistory removes messages, proposals and notes but not goals', async () => {
    const { a, b } = await pair();
    const msg = await say(a, 'hi');
    await saveProposal(a, {
      messageId: msg!.id,
      kind: 'goal_create',
      payload: {},
      basis: null,
      targetUpdatedAt: null,
    });
    await addNote(a, 'remember');
    await say(b, 'other member');
    await withHousehold(t.db, a.householdId, (tx) =>
      tx
        .insert(schema.goal)
        .values({ householdId: a.householdId, kind: 'generic', name: 'Keep me' }),
    );
    await clearHistory(a);
    expect(await listMessages(a, {})).toEqual([]);
    expect(await listNotes(a)).toEqual([]);
    expect(await listMessages(b, {})).toHaveLength(1);
    const goals = await withHousehold(t.db, a.householdId, (tx) => tx.select().from(schema.goal));
    expect(goals).toHaveLength(1);
    const proposals = await t.owner.select().from(schema.advisorProposal);
    expect(proposals.some((p) => p.messageId === msg!.id)).toBe(false);
  });

  it('stores member settings with defaults', async () => {
    const { a } = await pair();
    expect(await getMemberSettings(a)).toEqual({ proactiveEnabled: true, weeklyCap: null });
    await saveMemberSettings(a, { proactiveEnabled: false, weeklyCap: 3 });
    expect(await getMemberSettings(a)).toEqual({ proactiveEnabled: false, weeklyCap: 3 });
    await saveMemberSettings(a, { proactiveEnabled: true, weeklyCap: null });
    expect(await getMemberSettings(a)).toEqual({ proactiveEnabled: true, weeklyCap: null });
  });

  it('counts capped messages since a date and chat messages since local midnight', async () => {
    const { a, b } = await pair();
    await appendMessage(a, {
      role: 'assistant',
      origin: 'proactive',
      text: 'p1',
      eventKey: 'e1',
      countsTowardCap: true,
    });
    await appendMessage(a, { role: 'assistant', origin: 'proactive', text: 'p2', eventKey: 'e2' });
    await appendMessage(b, {
      role: 'assistant',
      origin: 'proactive',
      text: 'p3',
      eventKey: 'e3',
      countsTowardCap: true,
    });
    const capped = await withHousehold(t.db, a.householdId, (tx) =>
      countCappedSince(tx, a.householdId, a.userId, new Date(Date.now() - 60_000)),
    );
    expect(capped).toBe(1);
    const future = await withHousehold(t.db, a.householdId, (tx) =>
      countCappedSince(tx, a.householdId, a.userId, new Date(Date.now() + 60_000)),
    );
    expect(future).toBe(0);

    await say(a, 'q1');
    await say(a, 'q2');
    await appendMessage(a, { role: 'assistant', origin: 'chat', text: 'answer' });
    expect(await messagesToday(a, new Date())).toBe(2);
    // Local midnight follows the household timezone: far in the future there is nothing yet.
    expect(await messagesToday(a, new Date(Date.now() + 3 * 86_400_000))).toBe(0);
  });

  it('deleteAdvisorDataForUser removes one member within one household only', async () => {
    const { a, b } = await pair();
    await say(a, 'hi');
    await addNote(a, 'n');
    await saveMemberSettings(a, { proactiveEnabled: false, weeklyCap: 1 });
    await say(b, 'keep');
    await withHousehold(t.db, a.householdId, (tx) =>
      deleteAdvisorDataForUser(tx, a.householdId, a.userId),
    );
    expect(await listMessages(a, {})).toEqual([]);
    expect(await listNotes(a)).toEqual([]);
    expect(await getMemberSettings(a)).toEqual({ proactiveEnabled: true, weeklyCap: null });
    expect(await listMessages(b, {})).toHaveLength(1);
  });

  describe('claimChatTurn', () => {
    const now = () => new Date();

    it('stores the member message and returns its id', async () => {
      const { a } = await pair();
      const r = await claimChatTurn(a, { text: 'hello', dailyLimit: 5, now: now() });
      expect(r).toEqual({ userMessageId: expect.any(String) });
      const [m] = await listMessages(a, {});
      expect(m).toMatchObject({ role: 'user', origin: 'chat', text: 'hello' });
      expect('userMessageId' in r && m!.id).toBe('userMessageId' in r && r.userMessageId);
    });

    it('refuses at the daily limit and stores nothing', async () => {
      const { a } = await pair();
      await say(a, 'q1');
      await say(a, 'q2');
      expect(await claimChatTurn(a, { text: 'q3', dailyLimit: 2, now: now() })).toEqual({
        refused: 'daily_limit',
      });
      expect(await listMessages(a, {})).toHaveLength(2);
    });

    it('lets only one of two concurrent claims through at limit - 1', async () => {
      const { a } = await pair();
      await say(a, 'q1');
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          claimChatTurn(a, { text: `race ${i}`, dailyLimit: 2, now: now() }),
        ),
      );
      expect(results.filter((r) => 'userMessageId' in r)).toHaveLength(1);
      expect(results.filter((r) => 'refused' in r)).toHaveLength(3);
      expect(await messagesToday(a, now())).toBe(2);
    });

    it("refuses while a recent answer is pending, but not a stale or finished one, or another member's", async () => {
      const { a, b } = await pair();
      const pending = await appendMessage(a, {
        role: 'assistant',
        origin: 'chat',
        text: '',
        status: 'pending',
      });
      expect(await claimChatTurn(a, { text: 'x', dailyLimit: 9, now: now() })).toEqual({
        refused: 'busy',
      });
      expect(await claimChatTurn(b, { text: 'y', dailyLimit: 9, now: now() })).toHaveProperty(
        'userMessageId',
      );
      await t.owner
        .update(schema.advisorMessage)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(schema.advisorMessage.id, pending!.id));
      expect(await claimChatTurn(a, { text: 'z', dailyLimit: 9, now: now() })).toHaveProperty(
        'userMessageId',
      );
      await finishMessage(a, pending!.id, { text: 'done', status: 'complete' });
    });
  });
});
