import { describe, expect, it } from 'vitest';
import { budgetMonths, budgetStartFor } from './period';

describe('budgetMonths', () => {
  it('returns 12 inclusive month ranges starting at the start month', () => {
    const m = budgetMonths('2026-01-01', 'Europe/Lisbon');
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ index: 1, from: '2026-01-01', to: '2026-01-31' });
    expect(m[11]).toEqual({ index: 12, from: '2026-12-01', to: '2026-12-31' });
  });

  it('starts in October: month 1 is October of the start year, month 4 is January of the next', () => {
    const m = budgetMonths('2026-10-01', 'Europe/Lisbon');
    expect(m[0]).toEqual({ index: 1, from: '2026-10-01', to: '2026-10-31' });
    expect(m[3]).toEqual({ index: 4, from: '2027-01-01', to: '2027-01-31' });
    expect(m[11]).toEqual({ index: 12, from: '2027-09-01', to: '2027-09-30' });
  });

  it('handles leap and non-leap February across the year boundary', () => {
    expect(budgetMonths('2027-10-01', 'UTC')[4]).toEqual({
      index: 5,
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(budgetMonths('2026-10-01', 'UTC')[4]).toEqual({
      index: 5,
      from: '2027-02-01',
      to: '2027-02-28',
    });
  });

  it('keeps whole calendar days across DST changes in any timezone', () => {
    for (const tz of ['Europe/Lisbon', 'America/Sao_Paulo', 'Pacific/Auckland', 'Asia/Kolkata']) {
      const m = budgetMonths('2026-01-01', tz);
      expect(m[2]).toEqual({ index: 3, from: '2026-03-01', to: '2026-03-31' });
      expect(m[9]).toEqual({ index: 10, from: '2026-10-01', to: '2026-10-31' });
      // Months are contiguous: each starts the day after the previous one ends.
      for (let i = 1; i < 12; i++) {
        const prevEnd = new Date(`${m[i - 1]!.to}T00:00:00Z`).getTime() + 86_400_000;
        expect(new Date(`${m[i]!.from}T00:00:00Z`).getTime()).toBe(prevEnd);
      }
    }
  });

  it('rejects a start that is not the first of a month, or an unknown timezone', () => {
    expect(() => budgetMonths('2026-10-02', 'UTC')).toThrow(/first day/);
    expect(() => budgetMonths('2026-13-01', 'UTC')).toThrow();
    expect(() => budgetMonths('2026-10-01', 'Mars/Olympus')).toThrow(/timezone/i);
  });
});

describe('budgetStartFor', () => {
  it('puts 30 Sep in the budget that started the previous October', () => {
    expect(budgetStartFor('2027-09-30', 10)).toBe('2026-10-01');
    expect(budgetStartFor('2026-09-30', 10)).toBe('2025-10-01');
    expect(budgetStartFor('2026-10-01', 10)).toBe('2026-10-01');
    expect(budgetStartFor('2026-12-31', 10)).toBe('2026-10-01');
    expect(budgetStartFor('2027-01-01', 10)).toBe('2026-10-01');
  });

  it('calendar-year budgets start in January', () => {
    expect(budgetStartFor('2026-06-15', 1)).toBe('2026-01-01');
    expect(budgetStartFor('2026-12-31', 1)).toBe('2026-01-01');
  });
});
