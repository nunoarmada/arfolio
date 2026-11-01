export type RecurringCadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** One candidate payment: `amount` is signed minor units (an expense is negative). */
export type RecurringRow = {
  merchantKey: string;
  accountId: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  bookingDate: string;
  amount: number;
};

export type DetectedRecurring = {
  merchantKey: string;
  /** Account of the most recent occurrence. */
  accountId: string;
  cadence: RecurringCadence;
  /** Median amount of the occurrences, signed minor units. */
  typicalAmount: number;
  lastSeenOn: string;
  nextExpectedOn: string;
  occurrences: number;
};

/** Accepted gap in days between two consecutive occurrences. */
export const CADENCE_INTERVALS: Readonly<Record<RecurringCadence, readonly [number, number]>> = {
  weekly: [6, 8],
  monthly: [26, 35],
  quarterly: [85, 97],
  yearly: [350, 380],
};

/** How far back detection looks. */
export const RECURRING_LOOKBACK_DAYS = 400;

const CADENCES: readonly RecurringCadence[] = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MIN_OCCURRENCES: Record<RecurringCadence, number> = {
  weekly: 3,
  monthly: 3,
  quarterly: 3,
  yearly: 2,
};
/** Retained rows must be at least 60% of the merchant's rows within the series span. */
const MIN_RETAINED_SHARE_TENTHS = 6;
const MONTHS: Partial<Record<RecurringCadence, number>> = { monthly: 1, quarterly: 3, yearly: 12 };
/** A series is still alive until one occurrence plus this many days after the next expected. */
const GRACE_DAYS = 5;
const DAY_MS = 86_400_000;

function parse(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

const toDay = (date: string): number => {
  const { y, m, d } = parse(date);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

const fromDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => toDay(to) - toDay(from);

export const addDays = (date: string, days: number): string => fromDay(toDay(date) + days);

/** One cadence step after `date`; months are calendar months, clamping the day (31 Jan -> 28 Feb). */
export function addCadence(date: string, cadence: RecurringCadence): string {
  const months = MONTHS[cadence];
  if (months === undefined) return addDays(date, 7);
  const { y, m, d } = parse(date);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** `numerator / denominator` rounded half away from zero (denominator positive). */
function roundDiv(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) * 2 + denominator) / (denominator * 2));
}

/** An amount per cadence expressed per month: weekly x52/12, quarterly /3, yearly /12. */
export function monthlyEquivalent(amount: number, cadence: RecurringCadence): number {
  switch (cadence) {
    case 'weekly':
      return roundDiv(amount * 52, 12);
    case 'monthly':
      return amount;
    case 'quarterly':
      return roundDiv(amount, 3);
    case 'yearly':
      return roundDiv(amount, 12);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : roundDiv(sorted[mid - 1]! + sorted[mid]!, 2);
}

/** Whether `amount` is within +-10% of `reference` (integer arithmetic). */
export const withinTolerance = (amount: number, reference: number): boolean =>
  Math.abs(amount - reference) * 10 <= Math.abs(reference);

/** A payment at least one cadence minimum after `lastSeenOn` counts as its next occurrence. */
export const isNextOccurrence = (
  lastSeenOn: string,
  candidate: string,
  cadence: RecurringCadence,
): boolean => daysBetween(lastSeenOn, candidate) >= CADENCE_INTERVALS[cadence][0];

function fit(
  cadence: RecurringCadence,
  rows: RecurringRow[],
  group: readonly RecurringRow[],
  today: string,
  latestOfMerchant: string,
): DetectedRecurring | undefined {
  if (rows.length < MIN_OCCURRENCES[cadence]) return undefined;
  const [min, max] = CADENCE_INTERVALS[cadence];
  let skips = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const gap = daysBetween(rows[i - 1]!.bookingDate, rows[i]!.bookingDate);
    if (gap >= min && gap <= max) continue;
    // One missing occurrence: a gap of two steps. Only with a third point to confirm the rhythm.
    if (gap >= 2 * min && gap <= 2 * max && rows.length >= 3) {
      skips += 1;
      continue;
    }
    return undefined;
  }
  if (skips > 1) return undefined;

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  // Frequent shopping: a regular-looking subset of many purchases is not a subscription.
  const inWindow = group.filter(
    (r) => r.bookingDate >= first.bookingDate && r.bookingDate <= last.bookingDate,
  ).length;
  if (rows.length * 10 < inWindow * MIN_RETAINED_SHARE_TENTHS) return undefined;
  const nextExpectedOn = addCadence(last.bookingDate, cadence);
  // More than one occurrence overdue: the payment has stopped. A later payment of a different
  // amount (a price jump) is the next occurrence, so it keeps the series alive.
  const alive =
    isNextOccurrence(last.bookingDate, latestOfMerchant, cadence) &&
    daysBetween(last.bookingDate, latestOfMerchant) <= 2 * max
      ? latestOfMerchant
      : last.bookingDate;
  if (daysBetween(addCadence(addCadence(alive, cadence), cadence), today) > GRACE_DAYS) {
    return undefined;
  }
  return {
    merchantKey: last.merchantKey,
    accountId: last.accountId,
    cadence,
    typicalAmount: median(rows.map((r) => r.amount)),
    lastSeenOn: last.bookingDate,
    nextExpectedOn,
    occurrences: rows.length,
  };
}

/**
 * Finds payments that repeat on a fixed cadence. Rows are grouped by merchant key; amounts more
 * than 10% from the group median (one-off purchases, a price jump) are left out of the series;
 * the rest need 3 occurrences (2 for yearly) whose gaps fit the cadence, with one missing
 * occurrence tolerated. The result is ordered by merchant key.
 */
export function detectRecurring(rows: readonly RecurringRow[], today: string): DetectedRecurring[] {
  const groups = new Map<string, RecurringRow[]>();
  for (const r of rows) {
    const group = groups.get(r.merchantKey);
    if (group) group.push(r);
    else groups.set(r.merchantKey, [r]);
  }

  const found: DetectedRecurring[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const latestOfMerchant = group.reduce(
      (latest, r) => (r.bookingDate > latest ? r.bookingDate : latest),
      '',
    );
    const reference = median(group.map((r) => r.amount));
    const series = group
      .filter((r) => withinTolerance(r.amount, reference))
      .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.amount - b.amount);
    for (const cadence of CADENCES) {
      const detected = fit(cadence, series, group, today, latestOfMerchant);
      if (detected) {
        found.push(detected);
        break;
      }
    }
  }
  return found;
}
