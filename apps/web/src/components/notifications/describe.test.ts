import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, notificationPath } from '@arfolio/services/notification-links';
import type { NotificationDto } from '@/server/notifications-data';
import { describeNotification } from './describe';
import { formatMoneyFor } from '@/lib/money-privacy';

const L = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const base = { id: 'n1', read: false, createdAt: '2026-10-19T08:15:00.000Z' };

const deps = {
  t: (key: string) => key,
  connections: ((key: string) => key) as never,
  locale: 'pt-PT',
  timeZone: 'Europe/Lisbon',
  currency: 'EUR',
  now: new Date('2026-10-20T10:00:00Z'),
  formatMoney: formatMoneyFor(false),
};

const conn = (provider: 'enablebanking' | 'trading212') => ({ id: C, provider });

/** Per kind: the DTO and the shared-function target it corresponds to. */
const CASES: Array<
  [Exclude<(typeof NOTIFICATION_KINDS)[number], 'push_test'>, NotificationDto, object]
> = [
  [
    'budget_line_threshold',
    {
      ...base,
      kind: 'budget_line_threshold',
      lineId: L,
      lineName: 'x',
      budgetId: B,
      budgetStart: '2026-10-01',
      monthIndex: 3,
      threshold: 80,
      planned: 1,
      actual: 1,
    },
    { budgetStart: '2026-10-01', monthIndex: 3, lineId: L },
  ],
  [
    'budget_unallocated_negative',
    {
      ...base,
      kind: 'budget_unallocated_negative',
      budgetId: B,
      budgetStart: '2026-10-01',
      monthIndex: 2,
      remainingInHub: -1,
    },
    { budgetStart: '2026-10-01', monthIndex: 2 },
  ],
  [
    'recurring_missed',
    {
      ...base,
      kind: 'recurring_missed',
      recurringId: R,
      name: 'x',
      expectedOn: '2026-10-01',
      amount: 1,
      currency: 'EUR',
    },
    { recurringId: R },
  ],
  [
    'recurring_price_change',
    {
      ...base,
      kind: 'recurring_price_change',
      recurringId: R,
      name: 'x',
      previousAmount: 1,
      amount: 2,
      currency: 'EUR',
      date: '2026-10-01',
    },
    { recurringId: R },
  ],
  [
    'ai_report_ready',
    { ...base, kind: 'ai_report_ready', month: '2026-09' },
    { reportMonth: '2026-09' },
  ],
  ...(['consent_expiring', 'consent_expired', 'sync_failing'] as const).map(
    (kind) =>
      [
        kind,
        {
          ...base,
          kind,
          connectionId: C,
          connection: conn('trading212'),
          name: 'x',
          expiresAt: '2026-10-30T00:00:00.000Z',
          failures: 2,
          errorCode: null,
        } satisfies NotificationDto,
        { connectionId: C },
      ] as [(typeof NOTIFICATION_KINDS)[number], NotificationDto, object],
  ),
] as never;

describe('describeNotification action href', () => {
  it('covers every kind except push_test (which never reaches the list)', () => {
    expect(CASES.map(([k]) => k).sort()).toEqual(
      NOTIFICATION_KINDS.filter((k) => k !== 'push_test').sort(),
    );
  });

  it.each(CASES.map((c) => [c[0], c[1], c[2]] as const))(
    '%s uses the shared path',
    (kind, dto, target) => {
      expect(describeNotification(dto, deps).action.href).toBe(notificationPath(kind, target));
    },
  );

  it('only the bank renew variant differs from the shared path', () => {
    const dto = {
      ...base,
      kind: 'consent_expiring',
      connectionId: C,
      connection: conn('enablebanking'),
      name: 'x',
      expiresAt: '2026-10-30T00:00:00.000Z',
      failures: null,
      errorCode: null,
    } as NotificationDto;
    expect(describeNotification(dto, deps).action.href).toBe(
      `/connections/new/bank/authorise?connection=${C}`,
    );
  });

  it('falls back to the section when the target is gone', () => {
    const dto = {
      ...base,
      kind: 'recurring_missed',
      recurringId: null,
      name: null,
      expectedOn: null,
      amount: 0,
      currency: null,
    } as NotificationDto;
    expect(describeNotification(dto, deps).action.href).toBe(
      notificationPath('recurring_missed', {}),
    );
  });
});

describe('describeNotification in privacy mode', () => {
  it('masks amounts in the copy', () => {
    const d = describeNotification(
      {
        ...base,
        kind: 'budget_line_threshold',
        lineId: L,
        lineName: 'x',
        budgetId: B,
        budgetStart: '2026-10-01',
        monthIndex: 3,
        threshold: 120,
        planned: 10_000,
        actual: 12_345,
      },
      {
        ...deps,
        t: (key: string, values?: Record<string, string | number>) =>
          `${key} ${JSON.stringify(values ?? {})}`,
        formatMoney: formatMoneyFor(true),
      },
    );
    const text = `${d.title} ${d.body}`;
    expect(text).toContain('••••');
    expect(text).not.toContain('123,45');
    expect(text).not.toContain('100,00');
  });
});
