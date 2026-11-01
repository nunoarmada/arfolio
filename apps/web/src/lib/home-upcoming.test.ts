import { describe, expect, it } from 'vitest';
import type { RecurringDto } from './recurring-display';
import { selectUpcoming, upcomingDayLabel } from './home-upcoming';

const TODAY = '2026-10-23';

function item(over: Partial<RecurringDto> & { id: string }): RecurringDto {
  return {
    name: over.id,
    amount: -1000,
    currency: 'EUR',
    cadence: 'monthly',
    status: 'confirmed',
    source: 'declared',
    accountId: null,
    categoryId: null,
    budgetLineId: null,
    nextExpectedOn: '2026-10-25',
    lastSeenOn: null,
    ...over,
  };
}

describe('selectUpcoming', () => {
  it('is hidden for a household with no recurring items at all', () => {
    expect(selectUpcoming([], TODAY, 'EUR')).toEqual({ kind: 'hidden' });
  });

  it('keeps confirmed payments in the next seven days, today included, soonest first', () => {
    const view = selectUpcoming(
      [
        item({ id: 'b', name: 'B', nextExpectedOn: '2026-10-25' }),
        item({ id: 'a', name: 'A', nextExpectedOn: '2026-10-25' }),
        item({ id: 'today', name: 'Today', nextExpectedOn: TODAY }),
        item({ id: 'edge', name: 'Edge', nextExpectedOn: '2026-10-29' }),
        item({ id: 'late', name: 'Late', nextExpectedOn: '2026-10-30' }),
        item({ id: 'past', name: 'Past', nextExpectedOn: '2026-10-22' }),
      ],
      TODAY,
      'EUR',
    );
    expect(view.kind).toBe('list');
    if (view.kind !== 'list') return;
    expect(view.rows.map((r) => r.id)).toEqual(['today', 'a', 'b', 'edge']);
  });

  it('leaves out income, detections, undated items and anything outside the window', () => {
    const view = selectUpcoming(
      [
        item({ id: 'salary', amount: 200_000 }),
        item({ id: 'maybe', status: 'detected' }),
        item({ id: 'undated', nextExpectedOn: null }),
        item({ id: 'kept', nextExpectedOn: '2026-10-24' }),
      ],
      TODAY,
      'EUR',
    );
    expect(view.kind === 'list' && view.rows.map((r) => r.id)).toEqual(['kept']);
  });

  it('shows five rows and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => item({ id: `p${i}`, name: `P${i}` }));
    const view = selectUpcoming(many, TODAY, 'EUR');
    expect(view.kind === 'list' && view.rows).toHaveLength(5);
    expect(view.kind === 'list' && view.more).toBe(2);
  });

  it('totals the household currency over every payment of the week, not just the shown ones', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      item({ id: `p${i}`, name: `P${i}`, amount: -1500 }),
    );
    const view = selectUpcoming(many, TODAY, 'EUR');
    expect(view.kind === 'list' && view.total).toBe(10_500);
  });

  it('never sums another currency: it counts it', () => {
    const view = selectUpcoming(
      [item({ id: 'eur', amount: -2000 }), item({ id: 'usd', amount: -9999, currency: 'USD' })],
      TODAY,
      'EUR',
    );
    expect(view).toMatchObject({ kind: 'list', total: 2000, foreign: 1 });
  });

  it('has no total when every payment is in another currency (no fake zero)', () => {
    const view = selectUpcoming(
      [item({ id: 'usd', amount: -9999, currency: 'USD' })],
      TODAY,
      'EUR',
    );
    expect(view).toMatchObject({ kind: 'list', total: null, foreign: 1 });
  });

  it('rejects a total outside the safe-integer range', () => {
    const huge = [
      item({ id: 'a', amount: -Number.MAX_SAFE_INTEGER }),
      item({ id: 'b', amount: -Number.MAX_SAFE_INTEGER }),
    ];
    expect(() => selectUpcoming(huge, TODAY, 'EUR')).toThrow(RangeError);
  });

  it('says there is nothing this week when confirmed items exist but none is due', () => {
    const view = selectUpcoming(
      [item({ id: 'later', nextExpectedOn: '2026-11-20' })],
      TODAY,
      'EUR',
    );
    expect(view).toEqual({ kind: 'empty' });
  });

  it('asks to confirm detections when nothing is confirmed yet', () => {
    const view = selectUpcoming(
      [item({ id: 'm1', status: 'detected' }), item({ id: 'm2', status: 'detected' })],
      TODAY,
      'EUR',
    );
    expect(view).toEqual({ kind: 'toConfirm', detected: 2 });
  });

  it('prefers the quiet sentence over the nudge once something is confirmed', () => {
    const view = selectUpcoming(
      [item({ id: 'm1', status: 'detected' }), item({ id: 'c', nextExpectedOn: '2026-12-01' })],
      TODAY,
      'EUR',
    );
    expect(view).toEqual({ kind: 'empty' });
  });
});

describe('upcomingDayLabel', () => {
  const labels = { today: 'Hoje', tomorrow: 'Amanhã' };
  it('names today and tomorrow', () => {
    expect(upcomingDayLabel(TODAY, TODAY, 'pt-PT', labels)).toBe('Hoje');
    expect(upcomingDayLabel('2026-10-24', TODAY, 'pt-PT', labels)).toBe('Amanhã');
  });

  it('gives weekday, day and month otherwise', () => {
    expect(upcomingDayLabel('2026-10-27', TODAY, 'pt-PT', labels)).toMatch(/^\p{L}+\.?, .*27/u);
  });
});
