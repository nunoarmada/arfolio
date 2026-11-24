import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@arfolio/db';
import {
  addNote,
  appendMessage,
  getMemberSettings,
  getProposal,
  listGoals,
  listMessages,
  listNotes,
  saveProposal,
  type ServiceCtx,
} from '@arfolio/services';
import { startAdvisorTestDb, type AdvisorTestDb } from '../../advisor-test-utils';
import { integrationConfigFixture } from '../../test-utils';

const state = vi.hoisted(() => ({
  ctx: undefined as unknown,
  db: undefined as unknown,
  revalidated: [] as unknown[][],
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => state.revalidated.push(args),
}));
vi.mock('../../lib/db', () => ({ getDb: () => state.db }));
vi.mock('../service-ctx', () => ({ getServiceCtx: async () => state.ctx }));
vi.mock('../integration-config', () => ({
  getIntegrationConfig: async () =>
    integrationConfigFixture({ anthropicApiKey: 'sk-ant-e2e-fake-key-1' }),
}));
vi.mock('../../lib/env', () => ({
  getEnv: () => ({
    ADVISOR_LEARNING_MONTHS: 3,
    ADVISOR_WEEKLY_CAP: 2,
    ADVISOR_DAILY_MESSAGES: 50,
    ADVISOR_MAX_TOOL_CALLS: 8,
  }),
}));

import {
  applyAdvisorProposalAction,
  clearAdvisorHistoryAction,
  deleteAdvisorNoteAction,
  dismissAdvisorProposalAction,
  loadAdvisorPanelAction,
  loadAdvisorStateAction,
  loadOlderAdvisorMessagesAction,
  markAdvisorSeenAction,
  saveAdvisorSettingsAction,
} from './advisor';

describe('advisor actions', () => {
  let t: AdvisorTestDb;
  let hh: string;
  beforeAll(async () => {
    t = await startAdvisorTestDb();
    state.db = t.db;
    hh = await t.household();
  });
  afterAll(() => t.close());
  beforeEach(() => {
    state.revalidated = [];
  });

  const as = async (role: ServiceCtx['role'] = 'owner'): Promise<ServiceCtx> => {
    const ctx = await t.member(hh, role);
    state.ctx = ctx;
    return ctx;
  };

  async function goalProposal(ctx: ServiceCtx) {
    const msg = await appendMessage(ctx, { role: 'assistant', origin: 'chat', text: 'ok' });
    return saveProposal(ctx, {
      messageId: msg!.id,
      kind: 'goal_create',
      payload: { kind: 'goal_create', name: 'Trip', statedByMember: true, reason: 'You asked' },
      basis: null,
      targetUpdatedAt: null,
    });
  }

  it('applies a proposal once; a second apply is a conflict', async () => {
    const ctx = await as();
    const p = await goalProposal(ctx);
    expect(await applyAdvisorProposalAction(p.id)).toEqual({ ok: true, data: null });
    expect((await getProposal(ctx, p.id)).status).toBe('applied');
    expect((await listGoals(ctx)).map((g) => g.name)).toEqual(['Trip']);
    expect(state.revalidated).toContainEqual(['/', 'layout']);

    const again = await applyAdvisorProposalAction(p.id);
    expect(again).toMatchObject({ ok: false, code: 'conflict' });
    expect(await listGoals(ctx)).toHaveLength(1);
  });

  it('refuses a viewer applying a proposal', async () => {
    const viewer = await as('viewer');
    const p = await goalProposal(viewer);
    expect(await applyAdvisorProposalAction(p.id)).toEqual({ ok: false, code: 'forbidden' });
    expect((await getProposal(viewer, p.id)).status).toBe('pending');
  });

  it('lets a viewer dismiss a proposal', async () => {
    const viewer = await as('viewer');
    const p = await goalProposal(viewer);
    expect(await dismissAdvisorProposalAction(p.id)).toEqual({ ok: true, data: null });
    expect((await getProposal(viewer, p.id)).status).toBe('dismissed');
    expect(state.revalidated).toContainEqual(['/', 'layout']);
  });

  it('deletes a note and clears the history', async () => {
    const ctx = await as();
    const note = await addNote(ctx, 'Prefers short answers');
    await appendMessage(ctx, { role: 'user', origin: 'chat', text: 'hello' });
    expect(await deleteAdvisorNoteAction(note.id)).toEqual({ ok: true, data: null });
    expect(await listNotes(ctx)).toEqual([]);
    expect(await clearAdvisorHistoryAction()).toEqual({ ok: true, data: null });
    expect(await listMessages(ctx, {})).toEqual([]);
    expect(state.revalidated).toHaveLength(2);
  });

  it('saves the member settings, and rejects an invalid cap', async () => {
    const ctx = await as();
    expect(await saveAdvisorSettingsAction({ proactiveEnabled: false, weeklyCap: 1 })).toEqual({
      ok: true,
      data: null,
    });
    expect(await getMemberSettings(ctx)).toEqual({ proactiveEnabled: false, weeklyCap: 1 });
    const bad = await saveAdvisorSettingsAction({ proactiveEnabled: true, weeklyCap: -3 });
    expect(bad).toMatchObject({ ok: false, code: 'validation' });
    // Above the installation's cap (ADVISOR_WEEKLY_CAP, default 2).
    const high = await saveAdvisorSettingsAction({ proactiveEnabled: true, weeklyCap: 3 });
    expect(high).toMatchObject({ ok: false, code: 'validation' });
  });

  it("marks the member's advisor notifications read", async () => {
    const ctx = await as();
    const { notification, notificationRead } = schema;
    const [n] = await t.owner
      .insert(notification)
      .values({ householdId: hh, userId: ctx.userId, kind: 'advisor_message', payload: {} })
      .returning({ id: notification.id });
    expect(await markAdvisorSeenAction()).toEqual({ ok: true, data: null });
    const read = await t.owner
      .select()
      .from(notificationRead)
      .where(
        and(eq(notificationRead.notificationId, n!.id), eq(notificationRead.userId, ctx.userId)),
      );
    expect(read).toHaveLength(1);
  });

  it('loads older messages, oldest first', async () => {
    const ctx = await as();
    for (const text of ['a', 'b', 'c']) {
      await appendMessage(ctx, { role: 'user', origin: 'chat', text });
    }
    const newest = await listMessages(ctx, { limit: 1 });
    const result = await loadOlderAdvisorMessagesAction(newest[0]!.id);
    expect(result.ok && result.data.map((m) => m.text)).toEqual(['a', 'b']);
  });

  it("loads the member's advisor state for the window, with whether they may apply", async () => {
    const owner = await as();
    await appendMessage(owner, { role: 'user', origin: 'chat', text: 'hello' });
    const result = await loadAdvisorStateAction();
    expect(result.ok && result.data).toMatchObject({ available: true, canApply: true });
    expect(result.ok && result.data.messages.map((m) => m.text)).toEqual(['hello']);
    await as('viewer');
    const viewer = await loadAdvisorStateAction();
    expect(viewer.ok && viewer.data.canApply).toBe(false);
  });

  it("loads the member's notes and settings for the panel", async () => {
    const ctx = await as();
    const note = await addNote(ctx, 'Prefers short answers');
    expect(await loadAdvisorPanelAction()).toEqual({
      ok: true,
      data: {
        notes: [{ id: note.id, text: 'Prefers short answers' }],
        settings: { proactiveEnabled: true, weeklyCap: null },
        weeklyCapDefault: 2,
      },
    });
  });

  it('reports a vanished proposal, note or page anchor as a conflict, not a 404', async () => {
    await as();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(await dismissAdvisorProposalAction(missing)).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(await applyAdvisorProposalAction(missing)).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(await deleteAdvisorNoteAction(missing)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await loadOlderAdvisorMessagesAction(missing)).toMatchObject({
      ok: false,
      code: 'conflict',
    });
  });
});
