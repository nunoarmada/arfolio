import { addMonths } from '@arfolio/core';

/**
 * The page a notification opens, as one pure function shared by the web notification list and the
 * push sender. It imports nothing server-side (the web client bundle uses it through the
 * `@arfolio/services/notification-links` subpath), so keep it that way.
 */

export const NOTIFICATION_KINDS = [
  'consent_expiring',
  'consent_expired',
  'sync_failing',
  'recurring_missed',
  'recurring_price_change',
  'budget_line_threshold',
  'budget_unallocated_negative',
  'push_test',
  'ai_report_ready',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What the target is called today. Each id must already be validated (uuid) by the caller. */
export type NotificationLinkTarget = {
  /** First day of the budget's first month (`yyyy-mm-01`); null/absent when the budget is gone. */
  budgetStart?: string | null | undefined;
  /** 1..12 within the budget year; anything else is clamped (default 1). */
  monthIndex?: unknown;
  lineId?: string | null | undefined;
  recurringId?: string | null | undefined;
  connectionId?: string | null | undefined;
  /** The reported month of an AI report (`yyyy-mm`); validated by the caller. */
  reportMonth?: string | null | undefined;
};

const monthKey = (start: string, monthIndex: unknown): string => {
  const index =
    typeof monthIndex === 'number' && Number.isSafeInteger(monthIndex)
      ? Math.min(12, Math.max(1, monthIndex))
      : 1;
  return addMonths(start, index - 1).slice(0, 7);
};

/**
 * Same-origin relative path (with query and hash) for a notification, built from fixed segments
 * only. A target that is gone falls back to its section.
 */
export function notificationPath(kind: NotificationKind, t: NotificationLinkTarget = {}): string {
  switch (kind) {
    case 'budget_line_threshold': {
      if (!t.budgetStart) return '/budget';
      return `/budget?month=${monthKey(t.budgetStart, t.monthIndex)}${t.lineId ? `#line-${t.lineId}` : ''}`;
    }
    case 'budget_unallocated_negative':
      return t.budgetStart
        ? `/budget/transfers?month=${monthKey(t.budgetStart, t.monthIndex)}`
        : '/budget';
    case 'recurring_missed':
      return t.recurringId ? `/budget/subscriptions#rec-${t.recurringId}` : '/budget/subscriptions';
    case 'recurring_price_change':
      return t.recurringId
        ? `/budget/subscriptions?edit=${t.recurringId}`
        : '/budget/subscriptions';
    case 'consent_expiring':
    case 'consent_expired':
    case 'sync_failing':
      return t.connectionId ? `/connections#conn-${t.connectionId}` : '/connections';
    case 'ai_report_ready':
      return t.reportMonth ? `/insights/reports/${t.reportMonth}` : '/insights';
    case 'push_test':
      return '/';
  }
}
