import { describe, expect, it } from 'vitest';
import type { GoalView } from '../goals.js';
import type { Recurring } from '../recurring.js';
import { detectEvents, type EventInput } from './events.js';
import type { SpendingProfile } from './profile.js';

const typical = (median: number) => ({
  median,
  min: median,
  max: median,
  months: 3,
  outlierMonths: [],
});

function profile(over: { ready?: boolean; income?: number | null } = {}): SpendingProfile {
  const ready = over.ready ?? true;
  return {
    learning: { ready, completeMonths: ready ? 3 : 1, required: 3 },
    currency: 'EUR',
    window: [],
    categories: [],
    income:
      over.income === undefined
        ? typical(200_000)
        : over.income === null
          ? null
          : typical(over.income),
    recurringMonthly: 0,
    budgetLines: [],
  };
}

const goal = (over: Partial<GoalView> = {}): GoalView =>
  ({
    id: 'g1',
    name: 'Holiday',
    kind: 'savings',
    target: 10_000,
    targetDate: '2026-12-15',
    saved: 4_000,
    contribution: 1_000,
    ...over,
  }) as GoalView;

const recurring = (over: Partial<Recurring> = {}): Recurring =>
  ({
    id: 'r1',
    name: 'Streaming',
    amount: -999,
    currency: 'EUR',
    cadence: 'monthly',
    ...over,
  }) as Recurring;

const base = (over: Partial<EventInput> = {}): EventInput => ({
  today: '2026-11-24',
  profile: profile(),
  goals: [],
  recurringNew: [],
  recentInflows: [],
  lineMonth: [],
  hasAnyMessage: true,
  learnedSent: true,
  ...over,
});

const keys = (input: EventInput) => detectEvents(input).map((e) => e.key);

describe('detectEvents', () => {
  it('sends nothing when nothing happened', () => {
    expect(detectEvents(base())).toEqual([]);
  });

  describe('welcome and learned', () => {
    it('welcomes a member with no messages, outside the cap', () => {
      const [e] = detectEvents(base({ hasAnyMessage: false }));
      expect(e).toMatchObject({ key: 'welcome', type: 'welcome', countsTowardCap: false });
    });

    it('does not welcome a member who already has messages', () => {
      expect(keys(base({ hasAnyMessage: true }))).not.toContain('welcome');
    });

    it('reports what it learned once the learning period ends, outside the cap', () => {
      const [e] = detectEvents(base({ learnedSent: false }));
      expect(e).toMatchObject({ key: 'learned', type: 'learned', countsTowardCap: false });
    });

    it('does not report learning while it is still going or after it was sent', () => {
      expect(keys(base({ learnedSent: false, profile: profile({ ready: false }) }))).toEqual([]);
      expect(keys(base({ learnedSent: true }))).toEqual([]);
    });

    it('orders welcome, learned, then the capped events', () => {
      const out = detectEvents(
        base({
          hasAnyMessage: false,
          learnedSent: false,
          today: '2026-11-03',
          recurringNew: [recurring()],
        }),
      );
      expect(out.map((e) => e.key)).toEqual([
        'welcome',
        'learned',
        'checkin:2026-10',
        'recurring:r1',
      ]);
      expect(out.map((e) => e.countsTowardCap)).toEqual([false, false, true, true]);
    });
  });

  describe('monthly check-in', () => {
    it.each([
      ['2026-11-01', 'checkin:2026-10'],
      ['2026-11-07', 'checkin:2026-10'],
      ['2027-01-04', 'checkin:2026-12'],
    ])('on %s the check-in is %s', (today, key) => {
      const [e] = detectEvents(base({ today }));
      expect(e).toMatchObject({ key, type: 'checkin', countsTowardCap: true });
      expect(e!.facts).toMatchObject({ month: key.slice(8) });
    });

    it('is absent when there is no complete month of data yet', () => {
      const none = profile();
      none.learning.completeMonths = 0;
      expect(keys(base({ today: '2026-11-03', profile: none }))).toEqual([]);
    });

    it('is absent on day 8', () => {
      expect(keys(base({ today: '2026-11-08' }))).toEqual([]);
    });
  });

  describe('goal behind', () => {
    // today is 2026-11-24, so a target date of 2027-04-24 is exactly 5 months away.
    const at = (g: Partial<GoalView>) =>
      detectEvents(base({ goals: [goal(g)] })).filter((e) => e.type === 'goal_behind');

    it('fires when the projection is 89 % of the target', () => {
      // 5 months left (2027-04-24 date), saved 4000 + 5 * 980 = 8900
      const out = at({ targetDate: '2027-04-24', saved: 4_000, contribution: 980 });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        key: 'goal_behind:g1:2026-11',
        countsTowardCap: true,
      });
    });

    it('is silent when the projection is exactly 90 %', () => {
      expect(at({ targetDate: '2027-04-24', saved: 4_000, contribution: 1_000 })).toHaveLength(0);
    });

    it('is silent without a target amount or a target date', () => {
      expect(at({ target: null })).toHaveLength(0);
      expect(at({ targetDate: null })).toHaveLength(0);
    });

    it('is silent when the goal is already reached', () => {
      expect(at({ saved: 10_000, contribution: 0 })).toHaveLength(0);
    });

    it('is silent once the target date has passed, but not on the day itself', () => {
      expect(at({ targetDate: '2026-11-23', saved: 4_000, contribution: 0 })).toHaveLength(0);
      expect(at({ targetDate: '2026-11-24', saved: 4_000, contribution: 0 })).toHaveLength(1);
    });
  });

  describe('unusual income', () => {
    const inflow = (over: Partial<EventInput['recentInflows'][number]> = {}) => ({
      id: 't1',
      amount: 100_000,
      bookedOn: '2026-11-23',
      recurring: false,
      ...over,
    });
    const income = (i: EventInput['recentInflows']) =>
      detectEvents(base({ recentInflows: i })).filter((e) => e.type === 'unusual_income');

    it('fires for a non-recurring inflow of at least half the typical monthly income', () => {
      const [e] = income([inflow()]);
      expect(e).toMatchObject({ key: 'income:t1', countsTowardCap: true });
    });

    it('is silent just below half and fires exactly at half', () => {
      expect(income([inflow({ amount: 99_999 })])).toHaveLength(0);
      expect(income([inflow({ amount: 100_000 })])).toHaveLength(1);
    });

    it('is silent for recurring inflows and for ones older than three days', () => {
      expect(income([inflow({ recurring: true })])).toHaveLength(0);
      expect(income([inflow({ bookedOn: '2026-11-21' })])).toHaveLength(1);
      expect(income([inflow({ bookedOn: '2026-11-20' })])).toHaveLength(0);
    });

    it('is silent while the household is still learning or has no typical income', () => {
      const learning = detectEvents(
        base({ profile: profile({ ready: false }), recentInflows: [inflow()] }),
      );
      expect(learning).toEqual([]);
      const none = detectEvents(
        base({ profile: profile({ income: null }), recentInflows: [inflow()] }),
      );
      expect(none).toEqual([]);
    });
  });

  describe('new recurring', () => {
    it('fires once per detected item', () => {
      const out = detectEvents(
        base({ recurringNew: [recurring({ id: 'a' }), recurring({ id: 'b' })] }),
      );
      expect(out.map((e) => e.key)).toEqual(['recurring:a', 'recurring:b']);
      expect(out.every((e) => e.type === 'new_recurring' && e.countsTowardCap)).toBe(true);
    });
  });

  describe('budget over', () => {
    const over = (planned: number, actual: number) =>
      detectEvents(base({ lineMonth: [{ lineId: 'l1', name: 'Food', planned, actual }] })).filter(
        (e) => e.type === 'budget_over',
      );

    it('fires above 110 % and carries the month in its key', () => {
      const [e] = over(10_000, 11_100);
      expect(e).toMatchObject({ key: 'budget:l1:2026-11', countsTowardCap: true });
    });

    it('is silent at exactly 110 % and when nothing is planned', () => {
      expect(over(10_000, 11_000)).toHaveLength(0);
      expect(over(0, 500)).toHaveLength(0);
    });
  });
});
