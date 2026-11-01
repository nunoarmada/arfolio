import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { SnapshotDay } from '@arfolio/core';
import { schema, type Tx } from '@arfolio/db';

const { investmentBucketSnapshot } = schema;

/** `yyyy-mm-dd` of `days` days before the given `yyyy-mm-dd`. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/** Today's `yyyy-mm-dd` on the wall clock of the given (valid) IANA time zone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Bucket snapshot days per account for [from, to] (inclusive `yyyy-mm-dd`), ascending, for the
 * `investedDelta` of the saving lines linked to buckets (investment pies). Every day that has any
 * bucket snapshot on the account is returned, so a day on which none of the linked buckets has a
 * row still counts as a day; `rows` hold only the linked buckets of that account.
 */
export async function loadSnapshotDays(
  tx: Tx,
  householdId: string,
  linked: ReadonlyMap<string, ReadonlySet<string>>,
  range: { from: string; to: string },
): Promise<Map<string, SnapshotDay[]>> {
  const out = new Map<string, SnapshotDay[]>();
  const accountIds = [...linked.keys()];
  if (accountIds.length === 0) return out;

  const inRange = and(
    eq(investmentBucketSnapshot.householdId, householdId),
    inArray(investmentBucketSnapshot.accountId, accountIds),
    gte(investmentBucketSnapshot.asOf, range.from),
    lte(investmentBucketSnapshot.asOf, range.to),
  );
  const dayRows = await tx
    .selectDistinct({
      accountId: investmentBucketSnapshot.accountId,
      asOf: investmentBucketSnapshot.asOf,
    })
    .from(investmentBucketSnapshot)
    .where(inRange)
    .orderBy(asc(investmentBucketSnapshot.asOf));
  const byKey = new Map<string, SnapshotDay['rows'][number][]>();
  for (const r of dayRows) {
    const rows: SnapshotDay['rows'][number][] = [];
    byKey.set(`${r.accountId}:${r.asOf}`, rows);
    const list = out.get(r.accountId) ?? [];
    list.push({ asOf: r.asOf, rows });
    out.set(r.accountId, list);
  }

  const bucketIds = [...new Set([...linked.values()].flatMap((s) => [...s]))];
  if (bucketIds.length === 0) return out;
  const rows = await tx
    .select({
      accountId: investmentBucketSnapshot.accountId,
      asOf: investmentBucketSnapshot.asOf,
      bucketId: investmentBucketSnapshot.bucketId,
      investedMinor: investmentBucketSnapshot.investedMinor,
      currency: investmentBucketSnapshot.currency,
    })
    .from(investmentBucketSnapshot)
    .where(and(inRange, inArray(investmentBucketSnapshot.bucketId, bucketIds)));
  for (const r of rows) {
    if (!linked.get(r.accountId)?.has(r.bucketId)) continue;
    byKey.get(`${r.accountId}:${r.asOf}`)!.push({
      key: r.bucketId,
      investedMinor: r.investedMinor,
      currency: r.currency,
    });
  }
  return out;
}
