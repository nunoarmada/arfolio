import { monthlyEquivalent } from '@arfolio/core';
import { OVERDUE_GRACE_DAYS } from './budget-period';
import { dayDifference } from './dates';

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** The fields of a recurring item the subscriptions page works with (client-safe). */
export interface RecurringDto {
  id: string;
  name: string;
  /** Signed minor units: a payment is negative. */
  amount: number;
  currency: string;
  cadence: Cadence;
  status: 'detected' | 'confirmed' | 'dismissed';
  source: 'detected' | 'declared' | 'import';
  accountId: string | null;
  categoryId: string | null;
  budgetLineId: string | null;
  nextExpectedOn: string | null;
  lastSeenOn: string | null;
}

/** The expected date passed by more than the grace period (the rule behind the "missed" notice). */
export function isOverdue(nextExpectedOn: string | null, today: string): boolean {
  return nextExpectedOn !== null && dayDifference(today, nextExpectedOn) > OVERDUE_GRACE_DAYS;
}

const byNextDate = (a: RecurringDto, b: RecurringDto): number => {
  if (a.nextExpectedOn === b.nextExpectedOn)
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (a.nextExpectedOn === null) return 1;
  if (b.nextExpectedOn === null) return -1;
  return a.nextExpectedOn.localeCompare(b.nextExpectedOn);
};

/** "To confirm" are detections nobody has judged; the rest, except dismissed, are the fixed list. */
export function partitionRecurring(items: readonly RecurringDto[]): {
  detected: RecurringDto[];
  established: RecurringDto[];
} {
  const live = items.filter((i) => i.status !== 'dismissed');
  return {
    detected: live.filter((i) => i.status === 'detected').sort(byNextDate),
    established: live.filter((i) => i.status !== 'detected').sort(byNextDate),
  };
}

/** What a non-monthly item comes to per month, in minor units (signed like the amount). */
export function perMonth(item: Pick<RecurringDto, 'amount' | 'cadence'>): number {
  return monthlyEquivalent(item.amount, item.cadence);
}
