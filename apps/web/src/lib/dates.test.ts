import { formatMonthShort } from './dates';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayDifference,
  dayHeading,
  formatDate,
  isIsoDate,
  monthEnd,
  monthStart,
  todayIn,
} from './dates';

describe('dates', () => {
  it('computes today in the given time zone', () => {
    const instant = new Date('2026-10-18T23:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-10-18');
    expect(todayIn('Asia/Tokyo', instant)).toBe('2026-10-19');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-10-18');
  });

  it('adds days and months across boundaries', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
    expect(addMonths('2026-01-15', -2)).toBe('2025-11-01');
  });

  it('finds month bounds including leap years', () => {
    expect(monthStart('2026-10-18')).toBe('2026-10-01');
    expect(monthEnd('2026-10-18')).toBe('2026-10-31');
    expect(monthEnd('2024-02-10')).toBe('2024-02-29');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
  });

  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('14/10/2026')).toBe(false);
  });

  it('counts the days between two dates', () => {
    expect(dayDifference('2026-03-02', '2026-02-27')).toBe(3);
  });

  it('labels days: today, yesterday, weekday, and the year when it differs', () => {
    const labels = { today: 'Hoje', yesterday: 'Ontem' };
    expect(dayHeading('2026-10-18', '2026-10-18', 'pt-PT', labels)).toBe('Hoje');
    expect(dayHeading('2026-10-17', '2026-10-18', 'pt-PT', labels)).toBe('Ontem');
    expect(dayHeading('2026-10-14', '2026-10-18', 'pt-PT', labels)).toMatch(/^\S+, 14/);
    expect(dayHeading('2025-10-14', '2026-10-18', 'pt-PT', labels)).toContain('2025');
  });

  it('formats dates in the household locale', () => {
    expect(formatDate('2026-10-14', 'pt-PT')).toBe('14/10/2026');
    expect(formatDate('2026-10-14', 'en')).toMatch(/Oct 14, 2026/);
  });
});

describe('formatMonthShort', () => {
  it('writes the month as the sheet does, with a short or full year', () => {
    expect(formatMonthShort('2026-10-01', 'pt-PT')).toBe('out. 26');
    expect(formatMonthShort('2026-10-01', 'pt-PT', true)).toBe('out. 2026');
    expect(formatMonthShort('2027-01-15', 'en')).toBe('Jan 27');
  });
});
