import { describe, expect, it } from 'vitest';
import { barModel, linePace, lineStatus, summaryStatus, unbudgetedTotal } from './budget-status';

describe('lineStatus', () => {
  it('noData_status_for_saving_past_month', () => {
    const noData = { key: 'noData', tone: 'muted', icon: 'none', amount: 0 };
    expect(lineStatus('saving', 50000, 0, 'past', null, { noData: true })).toEqual(noData);
    expect(lineStatus('saving', 50000, 0, 'current', null, { noData: true })).toEqual(noData);
    expect(lineStatus('saving', 50000, 0, 'past', null, { noData: true }).key).not.toBe('notSaved');
    // Future months stay "planned"; other kinds ignore the flag; no flag keeps "notSaved".
    expect(lineStatus('saving', 50000, 0, 'future', null, { noData: true }).key).toBe('planned');
    expect(lineStatus('expense', 40000, 0, 'past', null, { noData: true }).key).toBe('left');
    expect(lineStatus('saving', 50000, 0, 'past').key).toBe('notSaved');
  });

  it('expense: remaining while on plan, muted', () => {
    expect(lineStatus('expense', 40000, 31240, 'past')).toEqual({
      key: 'left',
      tone: 'muted',
      icon: 'none',
      amount: 8760,
    });
  });

  it('expense: over the plan is negative with the excess', () => {
    expect(lineStatus('expense', 40000, 48650, 'current')).toEqual({
      key: 'over',
      tone: 'negative',
      icon: 'triangle',
      amount: 8650,
    });
  });

  it('expense: nothing planned but money spent', () => {
    expect(lineStatus('expense', 0, 2300, 'current')).toMatchObject({
      key: 'unplanned',
      tone: 'negative',
      amount: 2300,
    });
  });

  it('expense: warns from 85% in the current month, but not in a closed month', () => {
    expect(lineStatus('expense', 10000, 8500, 'current')).toMatchObject({
      key: 'left',
      tone: 'warning',
      icon: 'circle',
    });
    expect(lineStatus('expense', 10000, 8499, 'current', 1).tone).toBe('muted');
    expect(lineStatus('expense', 10000, 9000, 'past').tone).toBe('muted');
  });

  it('expense: exactly met reads as paid, never as a warning (current or closed month)', () => {
    for (const state of ['current', 'past'] as const) {
      expect(lineStatus('expense', 10000, 10000, state, 0.2)).toEqual({
        key: 'paid',
        tone: 'muted',
        icon: 'check',
        amount: 0,
      });
    }
    // One cent short of the plan is still a remaining amount (and a warning near the limit).
    expect(lineStatus('expense', 10000, 9999, 'current').key).toBe('left');
    // A future month and a zero plan are not "paid".
    expect(lineStatus('expense', 10000, 0, 'future').key).toBe('planned');
    expect(lineStatus('expense', 0, 0, 'current').key).toBe('left');
  });

  it('expense: warns when well ahead of the pace', () => {
    // 50% spent at 30% of the month.
    expect(lineStatus('expense', 10000, 5000, 'current', 0.3).tone).toBe('warning');
    expect(lineStatus('expense', 10000, 3200, 'current', 0.3).tone).toBe('muted');
  });

  it('income: to come, short once the month is over, received above plan', () => {
    expect(lineStatus('income', 100000, 40000, 'current')).toMatchObject({
      key: 'toCome',
      amount: 60000,
    });
    expect(lineStatus('income', 100000, 40000, 'past')).toMatchObject({
      key: 'short',
      tone: 'warning',
    });
    expect(lineStatus('income', 100000, 112000, 'current')).toEqual({
      key: 'received',
      tone: 'positive',
      icon: 'check',
      amount: 0,
      extra: 12000,
    });
    expect(lineStatus('income', 100000, 100000, 'past').extra).toBeUndefined();
  });

  it('saving: to go, not saved when closed, done at the plan; never negative', () => {
    expect(lineStatus('saving', 20000, 5000, 'current')).toMatchObject({
      key: 'toGo',
      amount: 15000,
    });
    expect(lineStatus('saving', 20000, 5000, 'past')).toMatchObject({
      key: 'notSaved',
      tone: 'warning',
    });
    expect(lineStatus('saving', 20000, 30000, 'current')).toMatchObject({
      key: 'done',
      tone: 'positive',
    });
  });

  it('a future month only names the plan', () => {
    expect(lineStatus('expense', 5000, 0, 'future')).toEqual({
      key: 'planned',
      tone: 'muted',
      icon: 'none',
      amount: 5000,
    });
  });

  it('income or saving with nothing planned and nothing received is just a plan of zero', () => {
    expect(lineStatus('income', 0, 0, 'current').key).toBe('planned');
    expect(lineStatus('saving', 0, -300, 'past').key).toBe('planned');
  });
});

describe('barModel', () => {
  it('an exactly met expense is a full neutral bar, not amber', () => {
    expect(barModel('expense', 10000, 10000, 'current', 0.2)).toMatchObject({
      fill: 1,
      tone: 'neutral',
      hatch: 0,
      over: 0,
    });
  });

  it('fills in proportion and stays primary on pace', () => {
    expect(barModel('expense', 40000, 10000, 'current', 0.3)).toMatchObject({
      fill: 0.25,
      tone: 'primary',
      hatch: 0,
      percent: 25,
      pace: 0.3,
    });
  });

  it('caps at 100% and hatches the excess (at most half the bar)', () => {
    expect(barModel('expense', 40000, 48000, 'past')).toMatchObject({
      fill: 1,
      tone: 'negative',
      over: 8000,
    });
    expect(barModel('expense', 40000, 48000, 'past').hatch).toBeCloseTo(8000 / 48000);
    expect(barModel('expense', 10000, 50000, 'past').hatch).toBe(0.5);
  });

  it('planned 0 and spending is a fully hatched bar; no spending is empty', () => {
    expect(barModel('expense', 0, 500, 'current')).toMatchObject({ fill: 1, hatch: 1 });
    expect(barModel('expense', 0, 0, 'current')).toMatchObject({ fill: 0, hatch: 0 });
  });

  it('negative actual (refunds beat spending) is an empty track', () => {
    expect(barModel('expense', 10000, -500, 'current')).toMatchObject({ fill: 0, over: 0 });
  });

  it('income and saving go positive at 100% and are never hatched', () => {
    expect(barModel('income', 100000, 130000, 'current')).toMatchObject({
      fill: 1,
      tone: 'positive',
      hatch: 0,
    });
    expect(barModel('saving', 20000, 10000, 'past')).toMatchObject({ fill: 0.5, tone: 'warning' });
    expect(barModel('saving', 20000, 10000, 'current')).toMatchObject({
      fill: 0.5,
      tone: 'primary',
    });
  });

  it('shows the pace tick for expenses in the current month only', () => {
    expect(barModel('expense', 100, 10, 'past', 0.5).pace).toBeNull();
    expect(barModel('expense', 100, 10, 'future', 0.5).pace).toBeNull();
    expect(barModel('income', 100, 10, 'current', 0.5).pace).toBeNull();
  });

  it('future months are empty', () => {
    expect(barModel('expense', 100, 50, 'future')).toMatchObject({ fill: 0 });
  });
});

describe('summaryStatus', () => {
  const lines = [
    { kind: 'expense' as const, planned: 100, actual: 50 },
    { kind: 'income' as const, planned: 100, actual: 0 },
  ];
  it('on track when nothing is over', () => {
    expect(summaryStatus(lines, { planned: 100, actual: 50 }, 'current')).toMatchObject({
      key: 'onTrack',
      tone: 'positive',
      ended: false,
    });
  });
  it('warns when a line is over but the total is not', () => {
    const over = [...lines, { kind: 'expense' as const, planned: 10, actual: 30 }];
    expect(summaryStatus(over, { planned: 110, actual: 80 }, 'current')).toMatchObject({
      key: 'linesOver',
      tone: 'warning',
      count: 1,
    });
  });
  it('is negative when the total is over, and says it ended in a closed month', () => {
    expect(summaryStatus(lines, { planned: 100, actual: 186 }, 'past')).toMatchObject({
      key: 'overPlan',
      tone: 'negative',
      over: 86,
      ended: true,
    });
  });
  it('a future month has not started', () => {
    expect(summaryStatus(lines, { planned: 100, actual: 0 }, 'future')).toMatchObject({
      key: 'notStarted',
      tone: 'muted',
    });
  });
  it('warns when spending runs ahead of the month, though no line is over', () => {
    // 93% spent at 74% of the month.
    expect(summaryStatus(lines, { planned: 100, actual: 93 }, 'current', 0.74)).toMatchObject({
      key: 'aheadOfPace',
      tone: 'warning',
      icon: 'triangle',
    });
    // Exactly at the margin is still on track; just past it is not.
    expect(summaryStatus(lines, { planned: 100, actual: 60 }, 'current', 0.5).key).toBe('onTrack');
    expect(summaryStatus(lines, { planned: 100, actual: 61 }, 'current', 0.5).key).toBe(
      'aheadOfPace',
    );
  });
  it('warns near the limit even without a pace, and not in closed months', () => {
    expect(summaryStatus(lines, { planned: 100, actual: 85 }, 'current')).toMatchObject({
      key: 'nearLimit',
      tone: 'warning',
    });
    expect(summaryStatus(lines, { planned: 100, actual: 90 }, 'past').key).toBe('onTrack');
  });
  it('lines over and overspending still win over the pace warning', () => {
    const over = [...lines, { kind: 'expense' as const, planned: 10, actual: 30 }];
    expect(summaryStatus(over, { planned: 110, actual: 100 }, 'current', 0.3).key).toBe(
      'linesOver',
    );
    expect(summaryStatus(lines, { planned: 100, actual: 120 }, 'current', 0.3).key).toBe(
      'overPlan',
    );
  });
});

describe('linePace', () => {
  it('keeps the pace for a line made of many small rows', () => {
    expect(linePace(0.1, { planned: 90000, largestRow: 20000 })).toBe(0.1);
  });

  it('drops the pace for a lump-sum bill (one row of half the plan or more)', () => {
    expect(linePace(0.1, { planned: 90000, largestRow: 90000 })).toBeNull();
    expect(linePace(0.1, { planned: 90000, largestRow: 45000 })).toBeNull();
    expect(linePace(0.1, { planned: 90000, largestRow: 44999 })).toBe(0.1);
  });

  it('leaves a missing pace or an unplanned line alone', () => {
    expect(linePace(null, { planned: 90000, largestRow: 90000 })).toBeNull();
    expect(linePace(0.1, { planned: 0, largestRow: 500 })).toBe(0.1);
  });

  it('a lump-sum line is no longer flagged ahead of pace, but still at 85%', () => {
    const rent = { planned: 90000, largestRow: 90000 };
    expect(lineStatus('expense', 90000, 60000, 'current', 0.07).tone).toBe('warning');
    expect(lineStatus('expense', 90000, 60000, 'current', linePace(0.07, rent)).tone).toBe('muted');
    expect(lineStatus('expense', 90000, 80000, 'current', linePace(0.07, rent)).tone).toBe(
      'warning',
    );
  });
});

describe('unbudgetedTotal', () => {
  it('adds the booked spending outside the budget, a refunded category never lowering it', () => {
    expect(unbudgetedTotal([{ actual: 4000 }, { actual: 1500 }, { actual: -700 }])).toBe(5500);
    expect(unbudgetedTotal([])).toBe(0);
  });
});

describe('summaryStatus with lump-sum lines', () => {
  const rent = { kind: 'expense' as const, planned: 80000, actual: 80000, largestRow: 80000 };
  const groceries = { kind: 'expense' as const, planned: 40000, actual: 1000, largestRow: 500 };
  const total = { planned: 120000, actual: 81000 };

  it('is ahead of pace when the plain total says so and no line is a lump sum', () => {
    const plain = { ...rent, largestRow: 1000 };
    expect(summaryStatus([plain, groceries], total, 'current', 0.07).key).toBe('aheadOfPace');
  });

  it('rent paid on day 2 with groceries on pace is not "ahead of pace"', () => {
    expect(summaryStatus([rent, groceries], total, 'current', 0.07).key).not.toBe('aheadOfPace');
  });

  it('still warns when the non-lump-sum lines are ahead of pace themselves', () => {
    const heavy = { kind: 'expense' as const, planned: 40000, actual: 20000, largestRow: 500 };
    expect(
      summaryStatus([rent, heavy], { planned: 120000, actual: 100000 }, 'current', 0.07).key,
    ).toBe('aheadOfPace');
  });
});
