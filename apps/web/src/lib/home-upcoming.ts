import { addDays, formatShortDay } from './dates';
import type { RecurringDto } from './recurring-display';

/** Payments are listed for today and the six days after it. */
export const UPCOMING_DAYS = 7;
/** Rows shown before the rest collapse into "Mais N pagamentos". */
export const UPCOMING_ROWS = 5;

export type UpcomingView =
  /** No recurring items at all: a new household does not see an empty widget. */
  | { kind: 'hidden' }
  /** Confirmed items exist, none is due this week. */
  | { kind: 'empty' }
  /** Nothing confirmed yet, but detections wait for a decision. */
  | { kind: 'toConfirm'; detected: number }
  | {
      kind: 'list';
      rows: RecurringDto[];
      /** Payments due this week beyond the rows shown. */
      more: number;
      /** Household-currency total of every payment due (minor units, positive); null when none is. */
      total: number | null;
      /** Payments in another currency: counted, never summed. */
      foreign: number;
    };

/**
 * What the home "Próximos pagamentos" block shows: confirmed payments (negative amounts) expected
 * from today to six days ahead, soonest first and by name. The total adds the household currency
 * in BigInt and rejects a result outside the safe-integer range.
 */
export function selectUpcoming(
  items: readonly RecurringDto[],
  today: string,
  currency: string,
): UpcomingView {
  const live = items.filter((i) => i.status !== 'dismissed');
  if (live.length === 0) return { kind: 'hidden' };
  const last = addDays(today, UPCOMING_DAYS - 1);
  const due = live
    .filter(
      (i) =>
        i.status === 'confirmed' &&
        i.amount < 0 &&
        i.nextExpectedOn !== null &&
        i.nextExpectedOn >= today &&
        i.nextExpectedOn <= last,
    )
    .sort(
      (a, b) =>
        a.nextExpectedOn!.localeCompare(b.nextExpectedOn!) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  if (due.length === 0) {
    const detected = live.filter((i) => i.status === 'detected').length;
    const confirmed = live.some((i) => i.status === 'confirmed');
    return detected > 0 && !confirmed ? { kind: 'toConfirm', detected } : { kind: 'empty' };
  }
  const own = due.filter((i) => i.currency === currency);
  let total: number | null = null;
  if (own.length > 0) {
    const sum = own.reduce((acc, i) => acc + BigInt(-i.amount), 0n);
    if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Upcoming total out of range');
    total = Number(sum);
  }
  return {
    kind: 'list',
    rows: due.slice(0, UPCOMING_ROWS),
    more: Math.max(due.length - UPCOMING_ROWS, 0),
    total,
    foreign: due.length - own.length,
  };
}

/** "Hoje", "Amanhã", else "ter., 27 out." in the household locale. */
export function upcomingDayLabel(
  iso: string,
  today: string,
  locale: string,
  labels: { today: string; tomorrow: string },
): string {
  if (iso === today) return labels.today;
  if (iso === addDays(today, 1)) return labels.tomorrow;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
  return `${weekday}, ${formatShortDay(iso, locale)}`;
}
