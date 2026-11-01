import { describe, expect, it } from 'vitest';
import { addCadence, detectRecurring, monthlyEquivalent, type RecurringRow } from './detect';

const row = (bookingDate: string, amount: number, merchantKey = 'd:netflix', accountId = 'a1') =>
  ({ merchantKey, accountId, bookingDate, amount }) satisfies RecurringRow;

describe('addCadence', () => {
  it('adds calendar months and clamps the day of month', () => {
    expect(addCadence('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(addCadence('2028-01-31', 'monthly')).toBe('2028-02-29');
    expect(addCadence('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(addCadence('2026-11-30', 'quarterly')).toBe('2027-02-28');
    expect(addCadence('2028-02-29', 'yearly')).toBe('2029-02-28');
  });

  it('adds seven days for weekly', () => {
    expect(addCadence('2026-12-28', 'weekly')).toBe('2027-01-04');
  });
});

describe('monthlyEquivalent', () => {
  it('normalises each cadence to a month with half-away-from-zero rounding', () => {
    expect(monthlyEquivalent(-1000, 'monthly')).toBe(-1000);
    expect(monthlyEquivalent(-1000, 'weekly')).toBe(-4333); // 4333.33
    expect(monthlyEquivalent(-1500, 'weekly')).toBe(-6500);
    expect(monthlyEquivalent(-1000, 'quarterly')).toBe(-333);
    expect(monthlyEquivalent(-1001, 'quarterly')).toBe(-334); // 333.67
    expect(monthlyEquivalent(-1200, 'yearly')).toBe(-100);
    expect(monthlyEquivalent(-1050, 'yearly')).toBe(-88); // 87.5 rounds away from zero
    expect(monthlyEquivalent(1050, 'yearly')).toBe(88);
  });
});

describe('detectRecurring', () => {
  const today = '2026-06-20';

  it('detects a monthly subscription with the most recent account and a calendar-aware next date', () => {
    const found = detectRecurring(
      [
        row('2026-03-31', -999, 'd:netflix', 'a1'),
        row('2026-04-30', -999, 'd:netflix', 'a1'),
        row('2026-05-31', -999, 'd:netflix', 'a2'),
      ],
      today,
    );
    expect(found).toEqual([
      {
        merchantKey: 'd:netflix',
        accountId: 'a2',
        cadence: 'monthly',
        typicalAmount: -999,
        lastSeenOn: '2026-05-31',
        nextExpectedOn: '2026-06-30',
        occurrences: 3,
      },
    ]);
  });

  it('detects weekly, quarterly and yearly cadences', () => {
    const weekly = detectRecurring(
      [row('2026-06-01', -500), row('2026-06-08', -500), row('2026-06-15', -500)],
      today,
    );
    expect(weekly[0]).toMatchObject({ cadence: 'weekly', nextExpectedOn: '2026-06-22' });
    const quarterly = detectRecurring(
      [row('2025-09-15', -4000), row('2025-12-15', -4000), row('2026-03-15', -4000)],
      today,
    );
    expect(quarterly[0]).toMatchObject({ cadence: 'quarterly', nextExpectedOn: '2026-06-15' });
    const yearly = detectRecurring(
      [row('2024-07-01', -9000), row('2025-07-01', -9000)],
      '2026-02-01',
    );
    expect(yearly[0]).toMatchObject({
      cadence: 'yearly',
      occurrences: 2,
      nextExpectedOn: '2026-07-01',
    });
  });

  it('needs three occurrences, or two for yearly', () => {
    expect(detectRecurring([row('2026-04-01', -999), row('2026-05-01', -999)], today)).toEqual([]);
    expect(detectRecurring([row('2026-05-01', -999)], today)).toEqual([]);
  });

  it('rejects intervals outside the cadence tolerance', () => {
    const irregular = detectRecurring(
      [row('2026-01-01', -999), row('2026-01-20', -999), row('2026-04-10', -999)],
      today,
    );
    expect(irregular).toEqual([]);
  });

  it('does not flag one-off purchases at the same merchant', () => {
    const found = detectRecurring(
      [
        row('2026-03-10', -2000, 'd:shop'),
        row('2026-04-22', -15000, 'd:shop'),
        row('2026-05-03', -800, 'd:shop'),
      ],
      today,
    );
    expect(found).toEqual([]);
  });

  it('ignores a one-off amount inside an otherwise regular series', () => {
    const found = detectRecurring(
      [
        row('2026-03-05', -999),
        row('2026-04-05', -999),
        row('2026-04-19', -4500),
        row('2026-05-05', -999),
      ],
      today,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      typicalAmount: -999,
      occurrences: 3,
      lastSeenOn: '2026-05-05',
    });
  });

  it('tolerates a price change of up to 10% in either direction', () => {
    const up = detectRecurring(
      [row('2026-03-05', -1000), row('2026-04-05', -1000), row('2026-05-05', -1090)],
      today,
    );
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ typicalAmount: -1000, occurrences: 3 });
    const down = detectRecurring(
      [row('2026-03-05', -1000), row('2026-04-05', -1000), row('2026-05-05', -910)],
      today,
    );
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ typicalAmount: -1000, occurrences: 3 });
  });

  it('leaves a price jump above 10% out of the series', () => {
    const found = detectRecurring(
      [
        row('2026-02-05', -1000),
        row('2026-03-05', -1000),
        row('2026-04-05', -1000),
        row('2026-05-05', -1200),
      ],
      today,
    );
    expect(found[0]).toMatchObject({
      typicalAmount: -1000,
      occurrences: 3,
      lastSeenOn: '2026-04-05',
    });
  });

  it('tolerates one skipped month', () => {
    const found = detectRecurring(
      [
        row('2026-01-10', -999),
        row('2026-02-10', -999),
        row('2026-04-10', -999),
        row('2026-05-10', -999),
      ],
      today,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cadence: 'monthly', occurrences: 4 });
  });

  it('does not tolerate two skipped months', () => {
    const found = detectRecurring(
      [
        row('2026-01-10', -999),
        row('2026-03-10', -999),
        row('2026-05-10', -999),
        row('2026-06-10', -999),
      ],
      today,
    );
    expect(found).toEqual([]);
  });

  it('drops a series that stopped more than one occurrence ago', () => {
    const found = detectRecurring(
      [row('2025-10-10', -999), row('2025-11-10', -999), row('2025-12-10', -999)],
      today,
    );
    expect(found).toEqual([]);
  });

  it('rejects frequent shopping where the retained rows are a minority of the merchant rows', () => {
    // 2-3 purchases a week for four months, some near the median at ~7 and ~30 day spacings.
    const shop = (d: string, a: number) => row(d, a, 'd:supermarket');
    const rows = [
      // Weekly Monday shop near the median ...
      shop('2026-03-02', -2000),
      shop('2026-03-09', -1990),
      shop('2026-03-16', -2010),
      shop('2026-03-23', -2050),
      shop('2026-03-30', -1950),
      // ... between smaller and larger midweek purchases.
      shop('2026-03-04', -1000),
      shop('2026-03-06', -4000),
      shop('2026-03-11', -1100),
      shop('2026-03-13', -4200),
      shop('2026-03-18', -900),
      shop('2026-03-20', -3900),
      shop('2026-03-25', -1050),
      shop('2026-03-27', -4100),
      shop('2026-03-31', -950),
      shop('2026-03-31', -3800),
    ];
    expect(detectRecurring(rows, '2026-04-03')).toEqual([]);
  });

  it('keeps a series whose merchant has only a few other purchases in between', () => {
    const found = detectRecurring(
      [
        row('2026-03-05', -999),
        row('2026-03-20', -4500),
        row('2026-04-05', -999),
        row('2026-05-05', -999),
      ],
      today,
    );
    expect(found).toHaveLength(1);
  });

  it('does not let a stray recent payment keep an old series alive', () => {
    const found = detectRecurring(
      [
        row('2025-10-10', -999),
        row('2025-11-10', -999),
        row('2025-12-10', -999),
        row('2026-06-15', -5000),
      ],
      today,
    );
    // The June payment is more than two months after the last regular one: not a continuation.
    expect(found).toEqual([]);
  });

  it('keeps merchants apart and is stable regardless of input order', () => {
    const rows = [
      row('2026-05-02', -500, 'm:gym'),
      row('2026-03-02', -500, 'm:gym'),
      row('2026-04-02', -500, 'm:gym'),
      row('2026-03-15', -999, 'd:netflix'),
      row('2026-05-15', -999, 'd:netflix'),
      row('2026-04-15', -999, 'd:netflix'),
    ];
    const keys = detectRecurring(rows, today).map((d) => d.merchantKey);
    expect(keys).toEqual(['d:netflix', 'm:gym']);
    expect(detectRecurring([...rows].reverse(), today)).toEqual(detectRecurring(rows, today));
  });
});
