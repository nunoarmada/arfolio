const MONTHLY_DENOMINATOR = 120_000n;

/** `numerator / denominator` rounded half away from zero (both BigInt, numerator >= 0). */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Whole calendar months from `from` to `to` (0 when `to` is not after `from`). A month counts once
 * the day-of-month is reached, clamped to the target month's length, so 31 Jan -> 29 Feb is 1.
 */
function wholeMonths(from: string, to: string): number {
  if (to <= from) return 0;
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7));
  const fd = Number(from.slice(8, 10));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  const td = Number(to.slice(8, 10));
  const lastOfTarget = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const months = (ty - fy) * 12 + (tm - fm) - (td < Math.min(fd, lastOfTarget) ? 1 : 0);
  return Math.max(months, 0);
}

/**
 * Value after straight monthly depreciation: value * (1 - bpsPerYear / 120000) ^ wholeMonths, i.e.
 * a simple monthly rate of bpsPerYear / 12 compounded per whole month elapsed (partial months are
 * ignored). Evaluated as an exact BigInt rational and rounded once, half away from zero; never
 * below 0 (a yearly rate of 1200% or more writes the value off in the first month).
 */
export function depreciatedValue(
  value: number,
  fromDate: string,
  toDate: string,
  bpsPerYear: number,
): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`value must be an integer: ${value}`);
  if (!Number.isSafeInteger(bpsPerYear) || bpsPerYear < 0) {
    throw new RangeError(`bpsPerYear must be a non-negative integer: ${bpsPerYear}`);
  }
  if (value <= 0) return 0;
  const months = BigInt(wholeMonths(fromDate, toDate));
  if (months === 0n || bpsPerYear === 0) return value;
  const keep = MONTHLY_DENOMINATOR - BigInt(bpsPerYear);
  if (keep <= 0n) return 0;
  return Number(roundDiv(BigInt(value) * keep ** months, MONTHLY_DENOMINATOR ** months));
}
