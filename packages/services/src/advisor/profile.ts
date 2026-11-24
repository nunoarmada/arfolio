// Pure helpers behind the advisor spending profile: which months are complete, and what a
// "typical" month looks like. No I/O here; `profile-data.ts` loads the numbers.

export type TypicalSpend = {
  /** Median of the values, in minor units (rounded to a whole unit). */
  median: number;
  /** Smallest and largest value once outlier months are left out. */
  min: number;
  max: number;
  /** Values looked at (at most the last six). */
  months: number;
  /** Indexes, within those values, of months far above the median. */
  outlierMonths: number[];
};

export type SpendingProfile = {
  learning: { ready: boolean; completeMonths: number; required: number };
  currency: string;
  /** The `yyyy-mm` months the figures cover, oldest first. */
  window: string[];
  categories: Array<{
    categoryId: string;
    name: string;
    group: string;
    typical: TypicalSpend | null;
  }>;
  income: TypicalSpend | null;
  /** Monthly cost of established recurring outflows, positive minor units. */
  recurringMonthly: number;
  budgetLines: Array<{
    lineId: string;
    name: string;
    typical: TypicalSpend | null;
    /** ISO timestamp of the line's last change. */
    updatedAt: string;
  }>;
};

/** How many of the latest months `typicalSpend` looks at. */
export const TYPICAL_WINDOW_MONTHS = 6;

const monthIndex = (month: string): number =>
  Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);

const monthFromIndex = (i: number): string =>
  `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

/**
 * The `yyyy-mm` months that ended before the month of `today` and start on or after
 * `firstBookedOn`. The month of `firstBookedOn` counts only when that is its first day: a
 * month the data joined halfway through is not a full picture.
 */
export function completeMonths(firstBookedOn: string | null, today: string): string[] {
  if (!firstBookedOn) return [];
  const first =
    monthIndex(firstBookedOn.slice(0, 7)) + (firstBookedOn.slice(8, 10) === '01' ? 0 : 1);
  const end = monthIndex(today.slice(0, 7)); // exclusive: the current month is not complete
  const out: string[] = [];
  for (let i = first; i < end; i += 1) out.push(monthFromIndex(i));
  return out;
}

function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const ascending = (a: number, b: number): number => a - b;

/**
 * Median, range and outliers of the last (up to) six monthly values. An outlier is a value
 * above `median + 2 * MAD` (median absolute deviation); when MAD is 0 a quarter of the median
 * stands in for it. Outliers do not feed `min` or `max` and are reported by index.
 */
export function typicalSpend(monthly: number[]): TypicalSpend {
  const values = monthly.slice(-TYPICAL_WINDOW_MONTHS);
  const sorted = [...values].sort(ascending);
  const median = medianOf(sorted);
  const mad = medianOf(values.map((v) => Math.abs(v - median)).sort(ascending));
  const threshold = median + 2 * (mad === 0 ? median * 0.25 : mad);
  const outlierMonths: number[] = [];
  const kept: number[] = [];
  values.forEach((v, i) => {
    if (v > threshold) outlierMonths.push(i);
    else kept.push(v);
  });
  return {
    median,
    min: kept.length ? Math.min(...kept) : 0,
    max: kept.length ? Math.max(...kept) : 0,
    months: values.length,
    outlierMonths,
  };
}
