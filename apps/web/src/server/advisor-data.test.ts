import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@arfolio/db';
import { appendMessage } from '@arfolio/services';
import { startAdvisorTestDb, type AdvisorTestDb } from '../advisor-test-utils';
import { integrationConfigFixture } from '../test-utils';

const state = vi.hoisted(() => ({ db: undefined as unknown, cfg: undefined as unknown }));
vi.mock('../lib/db', () => ({ getDb: () => state.db }));
vi.mock('../lib/env', () => ({
  getEnv: () => ({
    ADVISOR_LEARNING_MONTHS: 3,
    ADVISOR_WEEKLY_CAP: 2,
    ADVISOR_DAILY_MESSAGES: 50,
    ADVISOR_MAX_TOOL_CALLS: 8,
  }),
}));
vi.mock('./integration-config', () => ({ getIntegrationConfig: async () => state.cfg }));

import { loadAdvisorState, loadOlderAdvisorMessages, pickSuggestions } from './advisor-data';

const learning = { ready: false, completeMonths: 0, required: 3 };
const ready = { ready: true, completeMonths: 6, required: 3 };

describe('pickSuggestions', () => {
  it.each([
    [
      'still learning',
      { learning, hasEmergencyFund: false, goalsCount: 0 },
      ['whatLearned', 'setGoal', 'howThisMonth'],
    ],
    [
      'ready, no emergency fund',
      { learning: ready, hasEmergencyFund: false, goalsCount: 2 },
      ['howThisMonth', 'emergencyFund', 'whereSave'],
    ],
    [
      'ready with an emergency fund and goals',
      { learning: ready, hasEmergencyFund: true, goalsCount: 1 },
      ['howThisMonth', 'reviewGoals', 'whereSave'],
    ],
    [
      'ready with an emergency fund and no goals',
      { learning: ready, hasEmergencyFund: true, goalsCount: 0 },
      ['howThisMonth', 'whereSave', 'setGoal'],
    ],
  ])('%s', (_name, input, expected) => {
    expect(pickSuggestions(input)).toEqual(expected);
  });
});

describe('loadAdvisorState', () => {
  let t: AdvisorTestDb;
  beforeAll(async () => {
    t = await startAdvisorTestDb();
    state.db = t.db;
  });
  afterAll(() => t.close());
  beforeEach(() => {
    state.cfg = integrationConfigFixture({ anthropicApiKey: 'sk-ant-e2e-fake-key-1' });
  });

  it('is unavailable without an API key', async () => {
    state.cfg = integrationConfigFixture();
    const ctx = await t.member(await t.household());
    const s = await loadAdvisorState(ctx);
    expect(s).toMatchObject({ available: false, reason: 'no_key' });
  });

  it('is unavailable when the household switched AI off', async () => {
    const ctx = await t.member(await t.household({ aiEnabled: false }));
    const s = await loadAdvisorState(ctx);
    expect(s).toMatchObject({ available: false, reason: 'household_off' });
  });

  it("offers the learning suggestions and the member's own messages, oldest first", async () => {
    const hh = await t.household();
    const a = await t.member(hh);
    const b = await t.member(hh, 'viewer');
    await appendMessage(a, { role: 'user', origin: 'chat', text: 'first' });
    await appendMessage(a, { role: 'assistant', origin: 'chat', text: 'second' });
    await appendMessage(b, { role: 'user', origin: 'chat', text: 'other member' });

    const s = await loadAdvisorState(a);
    expect(s.available).toBe(true);
    expect(s.reason).toBeUndefined();
    expect(s.learning).toEqual({ ready: false, completeMonths: 0, required: 3 });
    expect(s.suggestions).toEqual(['whatLearned', 'setGoal', 'howThisMonth']);
    expect(s.messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(s.canApply).toBe(true);
    expect((await loadAdvisorState(b)).canApply).toBe(false);
  });

  it('reports a proactive message the member has not seen, for that member only', async () => {
    const hh = await t.household();
    const a = await t.member(hh);
    const b = await t.member(hh);
    expect((await loadAdvisorState(a)).unreadProactive).toBe(false);
    await t.owner
      .insert(schema.notification)
      .values({ householdId: hh, userId: a.userId, kind: 'advisor_message', payload: {} });
    expect((await loadAdvisorState(a)).unreadProactive).toBe(true);
    expect((await loadAdvisorState(b)).unreadProactive).toBe(false);
  });

  it('pages older messages before the oldest one the caller holds', async () => {
    const ctx = await t.member(await t.household());
    for (let i = 0; i < 35; i += 1) {
      await appendMessage(ctx, { role: 'user', origin: 'chat', text: `m${i}` });
    }
    const first = await loadAdvisorState(ctx);
    expect(first.messages).toHaveLength(30);
    expect(first.messages[0]!.text).toBe('m5');
    expect(first.messages.at(-1)!.text).toBe('m34');
    const older = await loadOlderAdvisorMessages(ctx, first.messages[0]!.id);
    expect(older.map((m) => m.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });
});
