/** One account's snapshot rows: every day that has a snapshot, with the linked keys' rows. */
export type SnapshotDay = {
  asOf: string; // yyyy-mm-dd
  rows: ReadonlyArray<{ key: string; investedMinor: number | null; currency: string }>;
};

export type InvestedDelta =
  | { kind: 'known'; delta: number; foreignRows: number; endAsOf: string | null }
  | { kind: 'noData' };

type DayInvested = { invested: number; foreignRows: number } | 'noData';

function dayInvested(day: SnapshotDay, keys: ReadonlySet<string>, currency: string): DayInvested {
  let invested = 0;
  let foreignRows = 0;
  for (const r of day.rows) {
    if (!keys.has(r.key)) continue;
    if (r.investedMinor === null) return 'noData';
    if (r.currency !== currency) {
      foreignRows += 1;
      continue;
    }
    invested += r.investedMinor;
  }
  return { invested, foreignRows };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Money put into the linked keys during the range: invested(end) - invested(baseline).
 *
 * - baseline = last snapshot day before `from`; none (or a null amount) means `noData`. With
 *   `baselineGraceDays` and no such day, the earliest snapshot day in [from, from + grace] is the
 *   baseline instead (a source that only started tracking at the start of the month);
 * - end = last snapshot day up to min(to, today); a future range is a known 0;
 * - a key missing from a chosen day counts 0 (sold out);
 * - rows in another currency are never summed; they are counted once, on the end day.
 *
 * `days` must be sorted ascending by `asOf`; dates are yyyy-mm-dd and compare lexicographically.
 */
export function investedDelta(
  days: readonly SnapshotDay[],
  keys: readonly string[],
  range: { from: string; to: string; today: string },
  currency: string,
  options: { baselineGraceDays?: number } = {},
): InvestedDelta {
  if (range.from > range.today) {
    return { kind: 'known', delta: 0, foreignRows: 0, endAsOf: null };
  }
  let baseline = days.findLast((d) => d.asOf < range.from);
  if (!baseline && options.baselineGraceDays) {
    const graceEnd = addDays(range.from, options.baselineGraceDays);
    baseline = days.find((d) => d.asOf >= range.from && d.asOf <= graceEnd);
  }
  if (!baseline) return { kind: 'noData' };
  const endLimit = range.to < range.today ? range.to : range.today;
  const end = days.findLast((d) => d.asOf <= endLimit);
  // A regular baseline is before `from`, so end >= baseline; a grace baseline can be after it.
  if (!end || end.asOf < baseline.asOf) return { kind: 'noData' };

  const set = new Set(keys);
  const base = dayInvested(baseline, set, currency);
  const last = dayInvested(end, set, currency);
  if (base === 'noData' || last === 'noData') return { kind: 'noData' };
  return {
    kind: 'known',
    delta: last.invested - base.invested,
    foreignRows: last.foreignRows,
    endAsOf: end.asOf,
  };
}
