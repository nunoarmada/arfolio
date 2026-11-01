import { describe, expect, it } from 'vitest';
import { barModel } from './budget-status';
import { paceFraction } from './budget-period';
import { formatShare, paceSummary } from './home-pace';

describe('paceSummary', () => {
  it('names the day, the days in the month and the two shares', () => {
    // 23 October: day 23 of 31 is 74% of the month; 78% of the plan is spent.
    expect(paceSummary('2026-10-23', '2026-10-01', 40_000, 31_200)).toEqual({
      day: 23,
      days: 31,
      spent: 0.78,
      elapsed: 23 / 31,
    });
  });

  it('is null when the month is not the current one', () => {
    expect(paceSummary('2026-10-23', '2026-09-01', 40_000, 31_200)).toBeNull();
    expect(paceSummary('2026-10-23', '2026-11-01', 40_000, 0)).toBeNull();
  });

  it('is null when nothing is planned: a share of zero is not a number', () => {
    expect(paceSummary('2026-10-23', '2026-10-01', 0, 5_000)).toBeNull();
  });

  it('keeps going past 100% so overspending reads as it is', () => {
    expect(paceSummary('2026-10-30', '2026-10-01', 10_000, 15_000)?.spent).toBe(1.5);
  });

  it('never reports a negative spend (a refund-only month)', () => {
    expect(paceSummary('2026-10-10', '2026-10-01', 10_000, -500)?.spent).toBe(0);
  });

  it('handles the first and the last day of the month', () => {
    expect(paceSummary('2026-10-01', '2026-10-01', 31_000, 0)).toEqual({
      day: 1,
      days: 31,
      spent: 0,
      elapsed: 1 / 31,
    });
    expect(paceSummary('2026-10-31', '2026-10-01', 31_000, 31_000)).toEqual({
      day: 31,
      days: 31,
      spent: 1,
      elapsed: 1,
    });
    expect(formatShare(1 / 31, 'pt-PT')).toBe('3%');
  });

  it('uses the real length of the month (February, leap year)', () => {
    expect(paceSummary('2028-02-14', '2028-02-01', 1_000, 500)).toMatchObject({
      day: 14,
      days: 29,
    });
  });

  it('puts the marker where the bar draws its pace tick', () => {
    const summary = paceSummary('2026-10-23', '2026-10-01', 40_000, 31_200)!;
    const tick = barModel(
      'expense',
      40_000,
      31_200,
      'current',
      paceFraction('2026-10-23', '2026-10-01'),
    ).pace;
    expect(summary.elapsed).toBe(tick);
  });
});

describe('formatShare', () => {
  it('rounds to a whole percent in the locale', () => {
    expect(formatShare(0.784, 'pt-PT')).toBe('78%');
    expect(formatShare(0.742, 'en')).toBe('74%');
  });

  it('says below 1% instead of a rounded 0%', () => {
    expect(formatShare(0.004, 'pt-PT')).toBe('<1%');
    expect(formatShare(0.004, 'en')).toBe('<1%');
  });

  it('never shows 100% before the plan is reached', () => {
    expect(formatShare(0.996, 'pt-PT')).toBe('99%');
    expect(formatShare(0.9999, 'en')).toBe('99%');
    expect(formatShare(1, 'pt-PT')).toBe('100%');
    expect(formatShare(1.004, 'pt-PT')).toBe('100%');
  });

  it('shows a true zero as 0%', () => {
    expect(formatShare(0, 'pt-PT')).toBe('0%');
  });
});
