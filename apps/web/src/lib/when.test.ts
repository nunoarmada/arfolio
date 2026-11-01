import { describe, expect, it } from 'vitest';
import { dayTime, relativeTime } from './when';

const NOW = new Date('2026-10-18T12:00:00Z');
const labels = {
  justNow: 'now',
  todayAt: (t: string) => `today ${t}`,
  tomorrowAt: (t: string) => `tomorrow ${t}`,
  dateAt: (d: string, t: string) => `${d} ${t}`,
};

describe('relativeTime', () => {
  it('speaks minutes, hours and days in the locale', () => {
    expect(relativeTime('2026-10-18T11:59:50Z', NOW, 'en', 'now')).toBe('now');
    expect(relativeTime('2026-10-18T11:30:00Z', NOW, 'en', 'now')).toMatch(/30 min/);
    expect(relativeTime('2026-10-18T10:00:00Z', NOW, 'pt-PT', 'now')).toBe('há 2 h');
    expect(relativeTime('2026-10-16T12:00:00Z', NOW, 'en', 'now')).toMatch(/2 days? ago/);
  });
});

describe('dayTime', () => {
  it('uses the household zone for the calendar day and the clock', () => {
    // 23:30 UTC on the 18th is 00:30 on the 19th in Lisbon (summer time): "tomorrow".
    expect(dayTime('2026-10-18T23:30:00Z', NOW, 'en-GB', 'Europe/Lisbon', labels)).toBe(
      'tomorrow 00:30',
    );
    expect(dayTime('2026-10-18T17:40:00Z', NOW, 'en-GB', 'Europe/Lisbon', labels)).toBe(
      'today 18:40',
    );
    expect(dayTime('2026-10-21T05:12:00Z', NOW, 'en-GB', 'UTC', labels)).toMatch(/21 Oct 05:12/);
  });
});
