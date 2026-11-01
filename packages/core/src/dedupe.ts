import { createHash } from 'node:crypto';
import { normalizeDescription } from './description';

export type DedupeRow = {
  accountId: string;
  bookingDate: string;
  amount: number;
  description: string;
};

export type DedupeInput = DedupeRow & { occurrence: number };

const SEP = '\u001f';

/** Identity of a row within a batch: the single place that normalises description noise. */
export function dedupeKey(r: DedupeRow): string {
  return [r.accountId, r.bookingDate, String(r.amount), normalizeDescription(r.description)].join(
    SEP,
  );
}

/** sha256 hex over the normalised fields, joined with a unit separator to avoid boundary collisions. */
export function dedupeHash(p: DedupeInput): string {
  const material = dedupeKey(p) + SEP + String(p.occurrence);
  return createHash('sha256').update(material).digest('hex');
}

/** The n-th row sharing a key within one batch gets occurrence n (0-based). */
export function assignOccurrences<T>(
  rows: T[],
  key: (r: T) => string,
): Array<T & { occurrence: number }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const k = key(row);
    const occurrence = seen.get(k) ?? 0;
    seen.set(k, occurrence + 1);
    return { ...row, occurrence };
  });
}
