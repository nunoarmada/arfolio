import { describe, expect, it } from 'vitest';
import { depreciatedValue } from './depreciation';

describe('depreciatedValue', () => {
  it('applies (1 - bps/120000) per whole month elapsed', () => {
    // 10 000,00 EUR at 15%/year: 1.25% per month
    expect(depreciatedValue(1_000_000, '2026-01-01', '2026-02-01', 1500)).toBe(987_500);
    expect(depreciatedValue(1_000_000, '2026-01-01', '2026-03-01', 1500)).toBe(975_156); // 975156.25
  });

  it('is unchanged within the first month and ignores partial months', () => {
    expect(depreciatedValue(1_000_000, '2026-01-10', '2026-02-09', 1500)).toBe(1_000_000);
    expect(depreciatedValue(1_000_000, '2026-01-10', '2026-02-10', 1500)).toBe(987_500);
  });

  it('counts whole calendar months across leap years, not days', () => {
    const across = depreciatedValue(1_000_000, '2027-03-01', '2029-03-01', 1200);
    expect(across).toBe(depreciatedValue(1_000_000, '2025-03-01', '2027-03-01', 1200));
    // the anniversary of 29 Feb is 28 Feb in a non-leap year (day clamped), so that is 12 months
    const year = depreciatedValue(1_000_000, '2028-03-01', '2029-03-01', 1200);
    expect(depreciatedValue(1_000_000, '2028-02-29', '2029-02-28', 1200)).toBe(year);
    expect(depreciatedValue(1_000_000, '2028-02-29', '2029-01-31', 1200)).not.toBe(year);
    expect(depreciatedValue(1_000_000, '2028-01-31', '2028-02-29', 1200)).toBe(990_000);
  });

  it('rounds half away from zero', () => {
    // 50 * (1 - 1200/120000) = 49.5 -> 50
    expect(depreciatedValue(50, '2026-01-01', '2026-02-01', 1200)).toBe(50);
    expect(depreciatedValue(150, '2026-01-01', '2026-02-01', 1200)).toBe(149); // 148.5 -> 149
  });

  it('never goes below 0, even when the monthly rate reaches 100% or more', () => {
    expect(depreciatedValue(1000, '2026-01-01', '2026-02-01', 120_000)).toBe(0);
    expect(depreciatedValue(1000, '2026-01-01', '2030-01-01', 200_000)).toBe(0);
    expect(depreciatedValue(1000, '2026-01-01', '2030-01-01', 20_000)).toBe(0); // decays to rounding zero
    expect(depreciatedValue(0, '2026-01-01', '2030-01-01', 1000)).toBe(0);
  });

  it('is unchanged for a zero rate or when toDate is not after fromDate', () => {
    expect(depreciatedValue(1000, '2026-01-01', '2036-01-01', 0)).toBe(1000);
    expect(depreciatedValue(1000, '2026-06-01', '2026-01-01', 1500)).toBe(1000);
  });

  it('is exact for long horizons (no float drift)', () => {
    // 100 years at 10%/yr => 1200 months
    const v = depreciatedValue(9_000_000_000_001, '1926-01-01', '2026-01-01', 1000);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});
