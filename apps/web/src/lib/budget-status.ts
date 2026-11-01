import type { MonthState } from './budget-period';

export type BudgetKind = 'income' | 'expense' | 'saving';
export type StatusTone = 'muted' | 'warning' | 'negative' | 'positive';
export type StatusIcon = 'none' | 'triangle' | 'circle' | 'check';
export type StatusKey =
  | 'left'
  | 'paid'
  | 'over'
  | 'unplanned'
  | 'toCome'
  | 'short'
  | 'received'
  | 'toGo'
  | 'notSaved'
  | 'noData'
  | 'done'
  | 'planned';

export interface LineStatus {
  key: StatusKey;
  tone: StatusTone;
  icon: StatusIcon;
  /** The amount the sentence names (minor units, never negative). */
  amount: number;
  /** "+x over" next to "Received" when income went past the plan. */
  extra?: number;
}

/** Booked spending outside the budget (the unbudgeted rows), refunded categories counting zero. */
export function unbudgetedTotal(rows: ReadonlyArray<{ actual: number }>): number {
  return rows.reduce((sum, r) => sum + Math.max(0, r.actual), 0);
}

/** Spending at or above this share of the plan is flagged in the current month. */
export const NEAR_LIMIT_PERCENT = 85;
/** Percentage points ahead of the month's pace that also flag an expense line. */
export const PACE_MARGIN = 0.1;

/**
 * The pace to compare a line with. A lump-sum bill (one booked row of at least half the plan,
 * like rent paid on day 2) is not "ahead of pace" however early in the month it lands, so it
 * gets none; the near-limit and over-plan rules still apply.
 */
export function linePace(
  pace: number | null,
  line: { planned: number; largestRow: number },
): number | null {
  if (pace === null || line.planned <= 0) return pace;
  return line.largestRow * 2 >= line.planned ? null : pace;
}

/** Whether an expense line deserves the warning tone (near the limit or well ahead of the pace). */
function nearLimit(planned: number, actual: number, state: MonthState, pace: number | null) {
  if (state !== 'current' || planned <= 0 || actual <= 0) return false;
  if (actual * 100 >= NEAR_LIMIT_PERCENT * planned) return true;
  return pace !== null && actual / planned - pace > PACE_MARGIN;
}

/** The word that says how a line stands. Colour and icon repeat it; they never carry it alone. */
export function lineStatus(
  kind: BudgetKind,
  planned: number,
  actual: number,
  state: MonthState,
  pace: number | null = null,
  opts?: { noData?: boolean },
): LineStatus {
  if (state === 'future') return { key: 'planned', tone: 'muted', icon: 'none', amount: planned };
  // A saving line with no snapshot to read has no actual: say so instead of "not saved".
  if (kind === 'saving' && opts?.noData) {
    return { key: 'noData', tone: 'muted', icon: 'none', amount: 0 };
  }

  if (kind === 'expense') {
    if (planned === 0 && actual > 0) {
      return { key: 'unplanned', tone: 'negative', icon: 'triangle', amount: actual };
    }
    if (actual > planned) {
      return { key: 'over', tone: 'negative', icon: 'triangle', amount: actual - planned };
    }
    // Exactly met: the line is settled, a calm "Pago" with a check, never a warning.
    if (planned > 0 && actual === planned) {
      return { key: 'paid', tone: 'muted', icon: 'check', amount: 0 };
    }
    const remaining = planned - actual;
    return nearLimit(planned, actual, state, pace)
      ? { key: 'left', tone: 'warning', icon: 'circle', amount: remaining }
      : { key: 'left', tone: 'muted', icon: 'none', amount: remaining };
  }

  if (planned === 0 && actual <= 0) {
    return { key: 'planned', tone: 'muted', icon: 'none', amount: 0 };
  }
  const reached = actual >= planned;
  const remaining = planned - actual;
  if (kind === 'income') {
    if (reached) {
      return {
        key: 'received',
        tone: 'positive',
        icon: 'check',
        amount: 0,
        ...(actual > planned ? { extra: actual - planned } : {}),
      };
    }
    return state === 'past'
      ? { key: 'short', tone: 'warning', icon: 'circle', amount: remaining }
      : { key: 'toCome', tone: 'muted', icon: 'none', amount: remaining };
  }
  if (reached) return { key: 'done', tone: 'positive', icon: 'check', amount: 0 };
  return state === 'past'
    ? { key: 'notSaved', tone: 'warning', icon: 'circle', amount: remaining }
    : { key: 'toGo', tone: 'muted', icon: 'none', amount: remaining };
}

export type BarTone = 'primary' | 'warning' | 'negative' | 'positive' | 'neutral';

export interface BarModel {
  /** Share of the track the fill covers, 0..1. */
  fill: number;
  tone: BarTone;
  /** Share of the track (right end) drawn as the over-spending hatch, 0..1. */
  hatch: number;
  /** Rounded actual / planned in percent, null when nothing is planned. */
  percent: number | null;
  /** Where the month's pace tick sits, 0..1, only for expenses in the current month. */
  pace: number | null;
  /** Amount over the plan (expense lines only, minor units). */
  over: number;
}

/** Everything the progress bar draws, from the same numbers the status word uses. */
export function barModel(
  kind: BudgetKind,
  planned: number,
  actual: number,
  state: MonthState,
  pace: number | null = null,
): BarModel {
  const percent = planned > 0 ? Math.round((actual * 100) / planned) : null;
  const tick = kind === 'expense' && state === 'current' ? pace : null;
  const empty: BarModel = { fill: 0, tone: 'primary', hatch: 0, percent, pace: tick, over: 0 };
  if (state === 'future' || actual <= 0) return empty;

  if (kind === 'expense') {
    if (planned === 0) return { ...empty, fill: 1, tone: 'negative', hatch: 1, over: actual };
    if (actual > planned) {
      return {
        ...empty,
        fill: 1,
        tone: 'negative',
        hatch: Math.min((actual - planned) / actual, 0.5),
        over: actual - planned,
      };
    }
    if (actual === planned) return { ...empty, fill: 1, tone: 'neutral' };
    return {
      ...empty,
      fill: actual / planned,
      tone: nearLimit(planned, actual, state, pace) ? 'warning' : 'primary',
    };
  }

  if (planned === 0) return { ...empty, fill: 1, tone: 'positive' };
  const fill = Math.min(actual / planned, 1);
  if (actual >= planned) return { ...empty, fill, tone: 'positive' };
  return { ...empty, fill, tone: state === 'past' ? 'warning' : 'primary' };
}

export type SummaryKey =
  'onTrack' | 'linesOver' | 'overPlan' | 'notStarted' | 'aheadOfPace' | 'nearLimit';

export interface SummaryStatus {
  key: SummaryKey;
  tone: StatusTone;
  icon: 'check' | 'triangle' | 'calendar';
  /** Month already ended: the sentence starts with "Terminou". */
  ended: boolean;
  /** Expense lines over their plan. */
  count: number;
  /** Total expense actual minus planned when positive, else 0. */
  over: number;
}

/** The headline of the month: on track, some lines over, over plan overall, or not started. */
export function summaryStatus(
  lines: ReadonlyArray<{
    kind: BudgetKind;
    planned: number;
    actual: number;
    /** Largest booked row of the line: lump-sum lines are left out of the pace test. */
    largestRow?: number;
  }>,
  expenseTotal: { planned: number; actual: number },
  state: MonthState,
  /** How far through the month today is (0..1), for the current month. */
  pace: number | null = null,
): SummaryStatus {
  const ended = state === 'past';
  if (state === 'future') {
    return { key: 'notStarted', tone: 'muted', icon: 'calendar', ended: false, count: 0, over: 0 };
  }
  const count = lines.filter((l) => l.kind === 'expense' && l.actual > l.planned).length;
  const over = Math.max(0, expenseTotal.actual - expenseTotal.planned);
  if (over > 0) return { key: 'overPlan', tone: 'negative', icon: 'triangle', ended, count, over };
  if (count > 0)
    return { key: 'linesOver', tone: 'warning', icon: 'triangle', ended, count, over: 0 };
  // The headline must not say "on track" over a bar that is amber: spending ahead of the
  // month's pace, or close to the limit, is a warning too (same rule as an expense line).
  if (state === 'current' && expenseTotal.planned > 0) {
    // Lump-sum lines (rent on day 2) are no sign of a fast month: the pace test runs on the total
    // without them.
    const lump = lines.filter(
      (l) =>
        l.kind === 'expense' &&
        linePace(pace, { planned: l.planned, largestRow: l.largestRow ?? 0 }) === null,
    );
    const pacedPlanned = expenseTotal.planned - lump.reduce((a, l) => a + l.planned, 0);
    const pacedActual = expenseTotal.actual - lump.reduce((a, l) => a + l.actual, 0);
    if (pace !== null && pacedPlanned > 0 && pacedActual / pacedPlanned - pace > PACE_MARGIN) {
      return { key: 'aheadOfPace', tone: 'warning', icon: 'triangle', ended, count: 0, over: 0 };
    }
    if (expenseTotal.actual * 100 >= NEAR_LIMIT_PERCENT * expenseTotal.planned) {
      return { key: 'nearLimit', tone: 'warning', icon: 'triangle', ended, count: 0, over: 0 };
    }
  }
  return { key: 'onTrack', tone: 'positive', icon: 'check', ended, count: 0, over: 0 };
}
