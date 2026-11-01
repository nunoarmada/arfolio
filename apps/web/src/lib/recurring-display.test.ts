import { describe, expect, it } from 'vitest';
import { isOverdue, partitionRecurring, perMonth, type RecurringDto } from './recurring-display';

const item = (over: Partial<RecurringDto>): RecurringDto => ({
  id: 'i',
  name: 'Item',
  amount: -999,
  currency: 'EUR',
  cadence: 'monthly',
  status: 'confirmed',
  source: 'declared',
  accountId: null,
  categoryId: null,
  budgetLineId: null,
  nextExpectedOn: null,
  lastSeenOn: null,
  ...over,
});

describe('isOverdue', () => {
  it('needs more than five days past the expected date', () => {
    expect(isOverdue('2026-10-01', '2026-10-06')).toBe(false);
    expect(isOverdue('2026-10-01', '2026-10-07')).toBe(true);
    expect(isOverdue(null, '2026-10-07')).toBe(false);
    expect(isOverdue('2026-10-20', '2026-10-07')).toBe(false);
  });
});

describe('partitionRecurring', () => {
  it('splits detections from the fixed list, hides dismissed, sorts by next date with unknown last', () => {
    const { detected, established } = partitionRecurring([
      item({
        id: 'a',
        name: 'A',
        status: 'detected',
        source: 'detected',
        nextExpectedOn: '2026-11-02',
      }),
      item({ id: 'b', name: 'B', nextExpectedOn: null }),
      item({ id: 'c', name: 'C', nextExpectedOn: '2026-10-30' }),
      item({ id: 'd', name: 'D', status: 'dismissed', source: 'detected' }),
      item({ id: 'e', name: 'E', nextExpectedOn: '2026-10-12' }),
      item({ id: 'f', name: 'Alpha', nextExpectedOn: null }),
    ]);
    expect(detected.map((i) => i.id)).toEqual(['a']);
    expect(established.map((i) => i.id)).toEqual(['e', 'c', 'f', 'b']);
  });
});

describe('perMonth', () => {
  it('turns a yearly payment into its monthly share, keeping the sign', () => {
    expect(perMonth(item({ amount: -12000, cadence: 'yearly' }))).toBe(-1000);
    expect(perMonth(item({ amount: -1000, cadence: 'monthly' }))).toBe(-1000);
    expect(perMonth(item({ amount: -3000, cadence: 'quarterly' }))).toBe(-1000);
  });
});
