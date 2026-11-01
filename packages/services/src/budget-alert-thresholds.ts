/**
 * The alert thresholds (percent of the planned amount) a line has reached. A threshold below 100
 * is a warning and fires when the actual reaches it. From 100 up it means "over budget", so the
 * actual must be strictly past that share of the plan: a line spent exactly to its plan is met,
 * not over.
 */
export function crossedThresholds(
  thresholds: readonly number[],
  actual: number,
  planned: number,
): number[] {
  return thresholds.filter((th) =>
    th >= 100 ? actual * 100 > th * planned : actual * 100 >= th * planned,
  );
}
