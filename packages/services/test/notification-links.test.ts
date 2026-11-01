import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, notificationPath, type NotificationKind } from '../src/index.js';

const L = '11111111-1111-4111-8111-111111111111';
const R = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const target = {
  budgetStart: '2026-10-01',
  monthIndex: 3,
  lineId: L,
  recurringId: R,
  connectionId: C,
  reportMonth: '2026-09',
};

/** Expected path with the target, and the section fallback when the target is gone. */
const EXPECTED: Record<NotificationKind, [string, string]> = {
  budget_line_threshold: [`/budget?month=2026-12#line-${L}`, '/budget'],
  budget_unallocated_negative: ['/budget/transfers?month=2026-12', '/budget'],
  recurring_missed: [`/budget/subscriptions#rec-${R}`, '/budget/subscriptions'],
  recurring_price_change: [`/budget/subscriptions?edit=${R}`, '/budget/subscriptions'],
  consent_expiring: [`/connections#conn-${C}`, '/connections'],
  consent_expired: [`/connections#conn-${C}`, '/connections'],
  sync_failing: [`/connections#conn-${C}`, '/connections'],
  push_test: ['/', '/'],
  ai_report_ready: ['/insights/reports/2026-09', '/insights'],
};

describe('notificationPath', () => {
  it('has an expectation for every kind (a new kind must be added here)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it.each(NOTIFICATION_KINDS)('%s: path with the target, section when it is gone', (kind) => {
    const [withTarget, gone] = EXPECTED[kind];
    expect(notificationPath(kind, target)).toBe(withTarget);
    expect(notificationPath(kind, {})).toBe(gone);
    expect(notificationPath(kind, target)).toMatch(/^\/(?!\/)/);
  });

  it('clamps monthIndex to 1..12 and defaults to 1', () => {
    const at = (monthIndex: unknown) =>
      notificationPath('budget_unallocated_negative', { budgetStart: '2026-10-01', monthIndex });
    expect(at(99)).toBe('/budget/transfers?month=2027-09');
    expect(at(0)).toBe('/budget/transfers?month=2026-10');
    expect(at('x')).toBe('/budget/transfers?month=2026-10');
    expect(at(undefined)).toBe('/budget/transfers?month=2026-10');
  });

  it('leaves the hash off a budget alert whose line is gone', () => {
    expect(
      notificationPath('budget_line_threshold', { budgetStart: '2026-10-01', monthIndex: 1 }),
    ).toBe('/budget?month=2026-10');
  });
});
