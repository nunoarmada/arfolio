import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  addNote,
  appendMessage,
  clearHistory,
  countCappedSince,
  deleteAdvisorDataForUser,
  deleteMessage,
  deleteNote,
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
    expect(third).not.toBeNull();
  });

  it('finishes, deletes and expires pending messages', async () => {
    const { a } = await pair();
    const msg = await appendMessage(a, {
      role: 'assistant',
      origin: 'chat',
      text: '',
      status: 'pending',
    });
    await finishMessage(a, msg!.id, { text: 'done', status: 'complete' });
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
});
