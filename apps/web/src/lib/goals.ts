import { parsePlanned } from './amount-input';
import { isIsoDate } from './dates';

/** What a goal card needs to decide what to show. Money is minor units of the household currency. */
export interface GoalModel {
  kind: 'generic' | 'emergency_fund';
  /** The target in force (an emergency fund's is derived from the budget); null: none. */
  target: number | null;
  saved: number;
  contribution: number;
  /** `yyyy-mm-dd` the household wants it by. */
  targetDate: string | null;
  remaining: number;
  months: number | null;
  /** `yyyy-mm-01` of the month the goal is reached. */
  expectedDate: string | null;
  progressBps: number | null;
}

export type GoalState =
  /** An emergency fund with nothing to derive its target from. */
  | 'no_budget'
  /** No target: only what is saved and the contribution are known. */
  | 'no_target'
  | 'reached'
  | 'open';

export function goalState(goal: GoalModel): GoalState {
  if (goal.target === null) return goal.kind === 'emergency_fund' ? 'no_budget' : 'no_target';
  // A target of 0 (a generic one, or a derived one with nothing planned) has nothing to reach.
  if (goal.target === 0) return 'no_target';
  return goal.remaining === 0 ? 'reached' : 'open';
}

/** Whole percent for display; the meter never rounds up to 100 before the goal is reached. */
export function progressPercent(bps: number | null): number {
  return bps === null ? 0 : Math.floor(bps / 100);
}

/** Whether the projection lands after the date the household wanted, or within it. */
export function dateVerdict(goal: GoalModel): 'late' | 'on_time' | null {
  if (!goal.targetDate || !goal.expectedDate || goal.months === null || goal.remaining === 0) {
    return null;
  }
  return goal.expectedDate > goal.targetDate ? 'late' : 'on_time';
}

/** The emergency fund first, then the household's own order. */
export function orderGoals<T extends { kind: string }>(goals: T[]): T[] {
  return [
    ...goals.filter((g) => g.kind === 'emergency_fund'),
    ...goals.filter((g) => g.kind !== 'emergency_fund'),
  ];
}

export function totalSaved(goals: Array<{ saved: number }>): number {
  return goals.reduce((sum, g) => sum + g.saved, 0);
}

export interface GoalFormValues {
  kind: 'generic' | 'emergency_fund';
  name: string;
  target: string;
  targetDate: string;
  where: 'account' | 'line' | 'none';
  accountId: string;
  lineId: string;
  contribution: string;
  /** "Já poupado": what was already put aside, on `alreadySavedDate` (empty: today). */
  alreadySaved: string;
  alreadySavedDate: string;
}

export type GoalFormError =
  | 'nameRequired'
  | 'targetInvalid'
  | 'dateInvalid'
  | 'contributionInvalid'
  | 'accountRequired'
  | 'lineRequired'
  | 'savedInvalid';

export interface GoalInput {
  kind: 'generic' | 'emergency_fund';
  name: string;
  targetAmount: number | null;
  targetDate: string | null;
  accountId: string | null;
  budgetLineId: string | null;
  monthlyContribution: number | null;
  /** Sent only when changed: an unchanged baseline lets the service carry the old line's savings. */
  savedBaseline?: number | null;
  savedBaselineDate?: string | null;
}

export type GoalFormResult =
  | { ok: true; input: GoalInput }
  | { ok: false; errors: Partial<Record<keyof GoalFormValues, GoalFormError>> };

/** An optional amount: empty is "not set" (null), a typed zero is zero. */
function optionalAmount(raw: string): { ok: true; minor: number | null } | { ok: false } {
  if (raw.trim() === '') return { ok: true, minor: null };
  const parsed = parsePlanned(raw);
  return parsed.ok ? { ok: true, minor: parsed.minor } : { ok: false };
}

/**
 * The typed form as the service wants it, or what is wrong, field by field. "Já poupado" only
 * matters for a goal not linked to an account (an account's balance is what is saved), and is
 * sent only when it differs from `initial` (the stored values; none for a new goal).
 */
export function parseGoalForm(values: GoalFormValues, initial?: GoalFormValues): GoalFormResult {
  const errors: Partial<Record<keyof GoalFormValues, GoalFormError>> = {};
  const name = values.name.trim();
  if (!name) errors.name = 'nameRequired';

  // An emergency fund's target is derived from the budget: nothing typed is sent.
  let targetAmount: number | null = null;
  if (values.kind === 'generic') {
    const target = optionalAmount(values.target);
    if (!target.ok) errors.target = 'targetInvalid';
    else targetAmount = target.minor;
  }

  const targetDate = values.targetDate.trim() === '' ? null : values.targetDate;
  if (targetDate !== null && !isIsoDate(targetDate)) errors.targetDate = 'dateInvalid';

  const contribution = optionalAmount(values.contribution);
  if (!contribution.ok) errors.contribution = 'contributionInvalid';

  if (values.where === 'account' && !values.accountId) errors.accountId = 'accountRequired';
  if (values.where === 'line' && !values.lineId) errors.lineId = 'lineRequired';

  let baseline: Pick<GoalInput, 'savedBaseline' | 'savedBaselineDate'> = {};
  const changed =
    values.alreadySaved.trim() !== (initial?.alreadySaved ?? '').trim() ||
    values.alreadySavedDate !== (initial?.alreadySavedDate ?? '');
  if (values.where !== 'account' && changed) {
    const saved = optionalAmount(values.alreadySaved);
    const date = values.alreadySavedDate.trim() === '' ? null : values.alreadySavedDate;
    if (!saved.ok) errors.alreadySaved = 'savedInvalid';
    else if (saved.minor === null) baseline = { savedBaseline: null, savedBaselineDate: null };
    else if (date !== null && !isIsoDate(date)) errors.alreadySavedDate = 'dateInvalid';
    else baseline = { savedBaseline: saved.minor, savedBaselineDate: date };
  }

  if (Object.keys(errors).length > 0 || !contribution.ok) return { ok: false, errors };
  return {
    ok: true,
    input: {
      ...baseline,
      kind: values.kind,
      name,
      targetAmount,
      targetDate,
      accountId: values.where === 'account' ? values.accountId : null,
      budgetLineId: values.where === 'line' ? values.lineId : null,
      monthlyContribution: contribution.minor,
    },
  };
}
