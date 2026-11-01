import { describe, expect, it } from 'vitest';
import {
  bpsToInput,
  divergesFromPlan,
  formatRate,
  parsePercent,
  parseTermInput,
  remainingInstalments,
  repaidPercent,
  splitTerm,
  upcomingInstalments,
} from './net-worth-schedule';

const rows = Array.from({ length: 30 }, (_, i) => ({
  n: i + 1,
  date: `${2026 + Math.floor((i + 8) / 12)}-${String(((i + 8) % 12) + 1).padStart(2, '0')}-15`,
  payment: 100,
  interest: 10,
  principalPaid: 90,
  balance: 3000 - (i + 1) * 90,
}));

describe('parsePercent', () => {
  it('reads pt-PT and en decimals into basis points without floats', () => {
    expect(parsePercent('3,5')).toEqual({ ok: true, bps: 350 });
    expect(parsePercent('3.50')).toEqual({ ok: true, bps: 350 });
    expect(parsePercent(' 0,07 ')).toEqual({ ok: true, bps: 7 });
    expect(parsePercent('12')).toEqual({ ok: true, bps: 1200 });
    expect(parsePercent('4,35 %')).toEqual({ ok: true, bps: 435 });
    expect(parsePercent('0')).toEqual({ ok: true, bps: 0 });
  });
  it('refuses empty, negative, malformed and over-precise input', () => {
    expect(parsePercent('')).toEqual({ ok: false, reason: 'empty' });
    expect(parsePercent('-1')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePercent('abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePercent('1,234')).toEqual({ ok: false, reason: 'invalid' });
    expect(parsePercent('1,2,3')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('bpsToInput and formatRate', () => {
  it('writes basis points the way the locale types them', () => {
    expect(bpsToInput(350, 'pt-PT')).toBe('3,5');
    expect(bpsToInput(350, 'en')).toBe('3.5');
    expect(bpsToInput(1200, 'pt-PT')).toBe('12');
    expect(bpsToInput(7, 'pt-PT')).toBe('0,07');
  });
  it('shows a rate with two decimals, or as few as needed', () => {
    // the percent sign follows whatever Intl emits for the locale
    expect(formatRate(350, 'pt-PT').replace(/\s/g, '')).toBe('3,50%');
    expect(formatRate(350, 'en')).toBe('3.50%');
    expect(formatRate(1500, 'pt-PT', { trim: true }).replace(/\s/g, '')).toBe('15%');
    expect(formatRate(1250, 'en', { trim: true })).toBe('12.5%');
  });
});

describe('term', () => {
  it('splits months into years and months', () => {
    expect(splitTerm(328)).toEqual({ years: 27, months: 4 });
    expect(splitTerm(8)).toEqual({ years: 0, months: 8 });
    expect(splitTerm(360)).toEqual({ years: 30, months: 0 });
  });
  it('joins typed years and months, both optional but not both empty', () => {
    expect(parseTermInput('30', '')).toEqual({ ok: true, months: 360 });
    expect(parseTermInput('', '18')).toEqual({ ok: true, months: 18 });
    expect(parseTermInput('2', '6')).toEqual({ ok: true, months: 30 });
    expect(parseTermInput('', '')).toEqual({ ok: false, reason: 'empty' });
    expect(parseTermInput('0', '0')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseTermInput('1,5', '')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseTermInput('51', '')).toEqual({ ok: false, reason: 'invalid' }); // over 600 months
    expect(parseTermInput('-1', '3')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('upcomingInstalments', () => {
  it('starts at the current month, takes the next 12 and flags this month', () => {
    const next = upcomingInstalments(rows, '2026-10-01', 12);
    expect(next).toHaveLength(12);
    expect(next[0]!.date.slice(0, 7)).toBe('2026-10');
    expect(next[0]!.thisMonth).toBe(true);
    expect(next.slice(1).every((r) => !r.thisMonth)).toBe(true);
  });
  it('starts at the next instalment when none falls this month', () => {
    const next = upcomingInstalments(rows.slice(5), '2026-01-01', 3);
    expect(next.map((r) => r.thisMonth)).toEqual([false, false, false]);
    expect(next).toHaveLength(3);
  });
  it('is empty once the loan is paid off', () => {
    expect(upcomingInstalments(rows, '2040-01-01', 12)).toEqual([]);
  });
});

describe('remainingInstalments', () => {
  it('counts the instalments dated after today', () => {
    expect(remainingInstalments(rows, '2026-10-20')).toBe(
      rows.filter((r) => r.date > '2026-10-20').length,
    );
    expect(remainingInstalments(rows, '2099-01-01')).toBe(0);
  });
});

describe('repaidPercent', () => {
  it('rounds the repaid share to a whole percent with integer maths', () => {
    expect(repaidPercent(24_000_000, 22_136_000)).toBe(8);
    expect(repaidPercent(1000, 1000)).toBe(0);
    expect(repaidPercent(1000, 0)).toBe(100);
  });
  it('is 0 for a zero principal and clamps a balance above the principal', () => {
    expect(repaidPercent(0, 0)).toBe(0);
    expect(repaidPercent(1000, 1500)).toBe(0);
  });
});

describe('divergesFromPlan', () => {
  it('uses 1% of the plan, but never less than 100 in major units', () => {
    expect(divergesFromPlan(22_000_000, 22_000_000)).toBe(false);
    // 1% of 220 000 € is 2 200 €
    expect(divergesFromPlan(22_000_000 + 219_000, 22_000_000)).toBe(false);
    expect(divergesFromPlan(22_000_000 + 221_000, 22_000_000)).toBe(true);
    // a small loan: 1% is 5 €, the floor is 100 €
    expect(divergesFromPlan(50_000 + 9_000, 50_000)).toBe(false);
    expect(divergesFromPlan(50_000 + 11_000, 50_000)).toBe(true);
    expect(divergesFromPlan(50_000 - 11_000, 50_000)).toBe(true);
  });
});
