import { describe, expect, it } from 'vitest';
import {
  dateVerdict,
  goalState,
  orderGoals,
  parseGoalForm,
  progressPercent,
  totalSaved,
  type GoalFormValues,
  type GoalModel,
} from './goals';

const base: GoalModel = {
  kind: 'generic',
  target: 300_000,
  saved: 100_000,
  contribution: 20_000,
  targetDate: null,
  remaining: 200_000,
  months: 10,
  expectedDate: '2027-08-01',
  progressBps: 3333,
};

describe('goalState', () => {
  it('has a target, a projection and a meter when a target is set', () => {
    expect(goalState(base)).toBe('open');
  });

  it('is reached when nothing remains', () => {
    expect(
      goalState({ ...base, saved: 300_000, remaining: 0, months: 0, progressBps: 10_000 }),
    ).toBe('reached');
  });

  it('shows only saved and contribution without a target', () => {
    expect(goalState({ ...base, target: null, progressBps: null, months: null })).toBe('no_target');
  });

  it('treats a target of zero like no target, not as reached', () => {
    const zero = { ...base, target: 0, saved: 0, remaining: 0, months: 0, progressBps: 10_000 };
    expect(goalState(zero)).toBe('no_target');
    expect(goalState({ ...zero, kind: 'emergency_fund' })).toBe('no_target');
  });

  it('says there is no budget for an emergency fund without a derived target', () => {
    expect(goalState({ ...base, kind: 'emergency_fund', target: null, progressBps: null })).toBe(
      'no_budget',
    );
    expect(goalState({ ...base, kind: 'emergency_fund' })).toBe('open');
  });
});

describe('progressPercent', () => {
  it('floors basis points to whole percent', () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(3333)).toBe(33);
    expect(progressPercent(9999)).toBe(99);
    expect(progressPercent(10_000)).toBe(100);
    expect(progressPercent(null)).toBe(0);
  });
});

describe('dateVerdict', () => {
  it('is late when the expected month is after the target date', () => {
    expect(dateVerdict({ ...base, targetDate: '2027-06-30' })).toBe('late');
  });

  it('is on time on or before the target date, whatever day of the month it is', () => {
    expect(dateVerdict({ ...base, targetDate: '2027-08-01' })).toBe('on_time');
    expect(dateVerdict({ ...base, targetDate: '2027-08-31' })).toBe('on_time');
    expect(dateVerdict({ ...base, targetDate: '2028-01-15' })).toBe('on_time');
  });

  it('says nothing without a target date, a projection or when already reached', () => {
    expect(dateVerdict(base)).toBeNull();
    expect(
      dateVerdict({ ...base, targetDate: '2027-06-30', months: null, expectedDate: null }),
    ).toBeNull();
    expect(
      dateVerdict({
        ...base,
        targetDate: '2020-01-01',
        remaining: 0,
        months: 0,
        expectedDate: '2026-10-01',
      }),
    ).toBeNull();
  });
});

describe('orderGoals', () => {
  it('puts the emergency fund first and keeps the rest in order', () => {
    const goals = [
      { id: 'a', kind: 'generic' as const },
      { id: 'b', kind: 'emergency_fund' as const },
      { id: 'c', kind: 'generic' as const },
    ];
    expect(orderGoals(goals).map((g) => g.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('totalSaved', () => {
  it('adds what every goal has saved', () => {
    expect(totalSaved([{ saved: 100 }, { saved: 250 }, { saved: 0 }])).toBe(350);
    expect(totalSaved([])).toBe(0);
  });
});

const form: GoalFormValues = {
  kind: 'generic',
  name: '  Férias  ',
  target: '3 000,50',
  targetDate: '2027-07-01',
  where: 'account',
  accountId: 'acc-1',
  lineId: '',
  contribution: '150',
  alreadySaved: '',
  alreadySavedDate: '',
};

describe('parseGoalForm: already saved', () => {
  const unlinked = { ...form, where: 'none' as const };

  it('sends the amount and its date for a goal not linked to an account', () => {
    expect(
      parseGoalForm({ ...unlinked, alreadySaved: '1 200,50', alreadySavedDate: '2026-05-01' }),
    ).toMatchObject({
      ok: true,
      input: { savedBaseline: 120_050, savedBaselineDate: '2026-05-01' },
    });
    // no date: the service dates it today
    expect(parseGoalForm({ ...unlinked, alreadySaved: '50' })).toMatchObject({
      ok: true,
      input: { savedBaseline: 5_000, savedBaselineDate: null },
    });
  });

  it('clears it when emptied, and refuses an invalid amount or date', () => {
    const initial = { ...unlinked, alreadySaved: '50', alreadySavedDate: '2026-05-01' };
    expect(parseGoalForm({ ...initial, alreadySaved: ' ' }, initial)).toMatchObject({
      ok: true,
      input: { savedBaseline: null, savedBaselineDate: null },
    });
    expect(parseGoalForm({ ...unlinked, alreadySaved: 'abc' })).toEqual({
      ok: false,
      errors: { alreadySaved: 'savedInvalid' },
    });
    expect(
      parseGoalForm({ ...unlinked, alreadySaved: '5', alreadySavedDate: '2026-02-30' }),
    ).toEqual({ ok: false, errors: { alreadySavedDate: 'dateInvalid' } });
  });

  it('leaves it out when unchanged (so a new budget line keeps what the old one saved) or linked to an account', () => {
    const initial = { ...unlinked, alreadySaved: '50', alreadySavedDate: '2026-05-01' };
    const relinked = parseGoalForm({ ...initial, where: 'line', lineId: 'line-2' }, initial);
    expect(relinked.ok && 'savedBaseline' in relinked.input).toBe(false);
    const account = parseGoalForm({ ...form, alreadySaved: '50' });
    expect(account.ok && 'savedBaseline' in account.input).toBe(false);
    const blankNew = parseGoalForm(unlinked);
    expect(blankNew.ok && 'savedBaseline' in blankNew.input).toBe(false);
  });
});

describe('parseGoalForm', () => {
  it('turns the typed values into the service input', () => {
    expect(parseGoalForm(form)).toEqual({
      ok: true,
      input: {
        kind: 'generic',
        name: 'Férias',
        targetAmount: 300_050,
        targetDate: '2027-07-01',
        accountId: 'acc-1',
        budgetLineId: null,
        monthlyContribution: 15_000,
      },
    });
  });

  it('keeps empty optional fields as null, and a typed zero as zero', () => {
    const parsed = parseGoalForm({
      ...form,
      target: '',
      targetDate: '',
      where: 'none',
      contribution: '0',
    });
    expect(parsed).toMatchObject({
      ok: true,
      input: {
        targetAmount: null,
        targetDate: null,
        accountId: null,
        budgetLineId: null,
        monthlyContribution: 0,
      },
    });
    const empty = parseGoalForm({ ...form, contribution: '  ' });
    expect(empty).toMatchObject({ ok: true, input: { monthlyContribution: null } });
  });

  it('links a budget line instead of an account', () => {
    expect(
      parseGoalForm({ ...form, where: 'line', lineId: 'line-1', accountId: 'acc-1' }),
    ).toMatchObject({
      ok: true,
      input: { accountId: null, budgetLineId: 'line-1' },
    });
  });

  it('never sends a target for an emergency fund (it is derived)', () => {
    expect(parseGoalForm({ ...form, kind: 'emergency_fund', target: '999' })).toMatchObject({
      ok: true,
      input: { kind: 'emergency_fund', targetAmount: null },
    });
  });

  it('names each problem by field', () => {
    const bad = parseGoalForm({
      ...form,
      name: ' ',
      target: 'abc',
      targetDate: '2027-02-30',
      contribution: '-5',
      where: 'account',
      accountId: '',
    });
    expect(bad).toEqual({
      ok: false,
      errors: {
        name: 'nameRequired',
        target: 'targetInvalid',
        targetDate: 'dateInvalid',
        contribution: 'contributionInvalid',
        accountId: 'accountRequired',
      },
    });
    expect(parseGoalForm({ ...form, where: 'line', lineId: '' })).toMatchObject({
      ok: false,
      errors: { lineId: 'lineRequired' },
    });
  });
});
