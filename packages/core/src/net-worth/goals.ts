export interface GoalProjectionInput {
  /** Target in minor units; null for a goal without one (nothing to project). */
  target: number | null;
  saved: number;
  monthlyContribution: number;
  /** YYYY-MM-DD */
  today: string;
}

export interface GoalProjection {
  /** Amount still missing, never negative; 0 when there is no target. */
  remaining: number;
  /** Whole months of contributions needed; null without a target or without a contribution. */
  months: number | null;
  /** First day (YYYY-MM-01) of the month the goal is reached; null when months is null. */
  expectedDate: string | null;
  /** floor(saved * 10000 / target), capped at 10000; null without a target. */
  progressBps: number | null;
}

function firstOfMonthPlus(today: string, months: bigint): string {
  const total =
    BigInt(Number(today.slice(0, 4))) * 12n + BigInt(Number(today.slice(5, 7)) - 1) + months;
  const year = total / 12n;
  const month = (total % 12n) + 1n;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/** Projects a savings goal: months = ceil(remaining / contribution), exact in BigInt. */
export function projectGoal(input: GoalProjectionInput): GoalProjection {
  const { target, saved, monthlyContribution, today } = input;
  if (target === null) {
    return { remaining: 0, months: null, expectedDate: null, progressBps: null };
  }
  if (saved >= target) {
    return {
      remaining: 0,
      months: 0,
      expectedDate: firstOfMonthPlus(today, 0n),
      progressBps: 10_000,
    };
  }
  const remaining = target - saved;
  // target > saved here; a non-positive saved amount still yields a (floored, never negative) progress
  const progress = saved <= 0 ? 0 : Number((BigInt(saved) * 10_000n) / BigInt(target));
  if (monthlyContribution <= 0) {
    return { remaining, months: null, expectedDate: null, progressBps: progress };
  }
  const c = BigInt(monthlyContribution);
  const months = (BigInt(remaining) + c - 1n) / c;
  return {
    remaining,
    months: Number(months),
    expectedDate: firstOfMonthPlus(today, months),
    progressBps: progress,
  };
}

/** Emergency fund target: the budget's average monthly planned expense times the months to cover. */
export function emergencyFundTarget(avgMonthlyPlannedExpense: number, months: number): number {
  return avgMonthlyPlannedExpense * months;
}
