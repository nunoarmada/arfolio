import { describe, expect, it } from 'vitest';
import type { NotificationRow } from '@arfolio/services';
import { toNotificationDto, type NotificationLookups } from './notifications-data';

const LINE = '11111111-1111-4111-8111-111111111111';
const BUDGET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

const row = (kind: NotificationRow['kind'], payload: Record<string, unknown>): NotificationRow =>
  ({
    id: 'n1',
    kind,
    payload,
    read: false,
    createdAt: new Date('2026-10-19T08:15:00Z'),
  }) as unknown as NotificationRow;

const lookups: Partial<NotificationLookups> = {
  budgets: new Map([[BUDGET, { startMonth: '2026-10-01' }]]),
  lines: new Map([[LINE, { name: 'Supermercado', budgetId: BUDGET }]]),
  recurring: new Map([[REC, { name: 'Streaming' }]]),
};

describe('toNotificationDto: budget kinds', () => {
  const payload = {
    budgetId: BUDGET,
    lineId: LINE,
    monthIndex: 2,
    threshold: 80,
    planned: 40000,
    actual: 33000,
  };

  it('names the line and the budget as they are now', () => {
    expect(toNotificationDto(row('budget_line_threshold', payload), lookups)).toMatchObject({
      kind: 'budget_line_threshold',
      lineId: LINE,
      lineName: 'Supermercado',
      budgetStart: '2026-10-01',
      monthIndex: 2,
      threshold: 80,
      planned: 40000,
      actual: 33000,
    });
  });

  it('a deleted line or budget leaves nothing to name (generic copy)', () => {
    const dto = toNotificationDto(row('budget_line_threshold', payload), {
      budgets: new Map(),
      lines: new Map(),
    });
    expect(dto).toMatchObject({ lineId: null, lineName: null, budgetId: null, budgetStart: null });
  });

  it('reads the unallocated notice and clamps a bad month index', () => {
    expect(
      toNotificationDto(
        row('budget_unallocated_negative', {
          budgetId: BUDGET,
          monthIndex: 99,
          remainingInHub: -23000,
        }),
        lookups,
      ),
    ).toMatchObject({ budgetStart: '2026-10-01', monthIndex: 12, remainingInHub: -23000 });
  });

  it('survives a hostile payload', () => {
    const dto = toNotificationDto(
      row('budget_line_threshold', {
        lineId: '<script>',
        budgetId: { a: 1 },
        threshold: 'x',
        planned: 1.5,
        actual: null,
        monthIndex: 'abc',
      }),
      lookups,
    );
    expect(dto).toMatchObject({
      lineId: null,
      budgetId: null,
      threshold: 0,
      planned: 0,
      actual: 0,
      monthIndex: 1,
    });
  });
});

describe('toNotificationDto: recurring kinds', () => {
  it('uses the current name of a renamed item', () => {
    expect(
      toNotificationDto(
        row('recurring_missed', {
          recurringId: REC,
          name: 'Old name',
          expectedOn: '2026-10-05',
          amount: -999,
          currency: 'EUR',
        }),
        lookups,
      ),
    ).toMatchObject({
      kind: 'recurring_missed',
      recurringId: REC,
      name: 'Streaming',
      expectedOn: '2026-10-05',
      amount: -999,
      currency: 'EUR',
    });
  });

  it('a deleted item gets no name and no link', () => {
    expect(
      toNotificationDto(
        row('recurring_price_change', {
          recurringId: REC,
          name: 'Gone',
          previousAmount: -999,
          amount: -1299,
          currency: 'EUR',
          date: '2026-10-02',
        }),
        { recurring: new Map() },
      ),
    ).toMatchObject({
      kind: 'recurring_price_change',
      recurringId: null,
      name: null,
      previousAmount: -999,
      amount: -1299,
      date: '2026-10-02',
    });
  });
});

describe('toNotificationDto: connection kinds', () => {
  it('keeps the connection fields', () => {
    expect(
      toNotificationDto(
        row('sync_failing', {
          connectionId: 'abc',
          displayName: 'Banco Exemplo',
          consecutiveFailures: 3.7,
          errorCode: 'unavailable',
        }),
        { connections: new Map([['abc', 'enablebanking' as const]]) },
      ),
    ).toMatchObject({
      kind: 'sync_failing',
      connection: { id: 'abc', provider: 'enablebanking' },
      name: 'Banco Exemplo',
      failures: 3,
      errorCode: 'unavailable',
    });
  });
});

describe('toNotificationDto: ai_report_ready', () => {
  it('reads the month from the payload', () => {
    expect(toNotificationDto(row('ai_report_ready', { month: '2026-09' }))).toMatchObject({
      kind: 'ai_report_ready',
      month: '2026-09',
    });
  });

  it('drops a malformed month', () => {
    expect(toNotificationDto(row('ai_report_ready', { month: '../x' }))).toMatchObject({
      kind: 'ai_report_ready',
      month: null,
    });
  });
});
