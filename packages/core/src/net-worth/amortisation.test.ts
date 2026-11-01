import { describe, expect, it } from 'vitest';
import { amortisationSchedule, annuityPayment, scheduledBalanceAt } from './amortisation';

const mortgage = {
  principal: 24_000_000,
  annualRateBps: 350,
  termMonths: 360,
  startDate: '2026-01-31',
};

describe('annuityPayment', () => {
  it('gives the standard payment for 240 000 EUR at 3.5% over 30 years', () => {
    expect(annuityPayment(24_000_000, 350, 360)).toBe(107_771);
  });

  it('splits principal evenly (floored) at 0%', () => {
    expect(annuityPayment(1_200_000, 0, 120)).toBe(10_000);
    expect(annuityPayment(1000, 0, 3)).toBe(333);
  });

  it('is the whole principal plus one month of interest for a single instalment', () => {
    expect(annuityPayment(120_000, 600, 1)).toBe(120_600);
    expect(annuityPayment(5000, 0, 1)).toBe(5000);
  });

  it('rejects invalid input', () => {
    expect(() => annuityPayment(100, 0, 0)).toThrow(RangeError);
    expect(() => annuityPayment(-1, 0, 12)).toThrow(RangeError);
    expect(() => annuityPayment(100, -1, 12)).toThrow(RangeError);
    expect(() => annuityPayment(1.5, 0, 12)).toThrow(RangeError);
  });
});

describe('amortisationSchedule', () => {
  it('ends at exactly 0 after the last instalment, which absorbs the rounding', () => {
    const rows = amortisationSchedule(mortgage);
    expect(rows).toHaveLength(360);
    const last = rows[359]!;
    expect(last.balance).toBe(0);
    expect(last.n).toBe(360);
    expect(Math.abs(last.payment - 107_771)).toBeLessThan(360);
    expect(rows.slice(0, 359).every((r) => r.payment === 107_771)).toBe(true);
    expect(rows.reduce((a, r) => a + r.principalPaid, 0)).toBe(mortgage.principal);
    for (const r of rows) expect(r.payment).toBe(r.interest + r.principalPaid);
  });

  it('computes monthly interest as round(balance * bps / 120000)', () => {
    const [first, second] = amortisationSchedule(mortgage);
    expect(first!.interest).toBe(70_000); // 24_000_000 * 350 / 120_000
    expect(first!.principalPaid).toBe(37_771);
    expect(first!.balance).toBe(24_000_000 - 37_771);
    expect(second!.interest).toBe(Math.round((first!.balance * 350) / 120_000));
  });

  it('dates payment n at startDate + n months, clamping the day', () => {
    const rows = amortisationSchedule(mortgage);
    expect(rows[0]!.date).toBe('2026-02-28');
    expect(rows[1]!.date).toBe('2026-03-31');
    expect(rows[2]!.date).toBe('2026-04-30');
    expect(rows[12]!.date).toBe('2027-02-28');
    expect(rows[359]!.date).toBe('2056-01-31');
    const leap = amortisationSchedule({ ...mortgage, startDate: '2027-12-31', termMonths: 3 });
    expect(leap.map((r) => r.date)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('at 0% pays principal / term with the remainder in the last instalment', () => {
    const rows = amortisationSchedule({
      principal: 1000,
      annualRateBps: 0,
      termMonths: 3,
      startDate: '2026-01-15',
    });
    expect(rows.map((r) => r.payment)).toEqual([333, 333, 334]);
    expect(rows.map((r) => r.interest)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.balance)).toEqual([667, 334, 0]);
  });

  it('handles a single instalment', () => {
    const rows = amortisationSchedule({
      principal: 120_000,
      annualRateBps: 600,
      termMonths: 1,
      startDate: '2026-01-10',
    });
    expect(rows).toEqual([
      {
        n: 1,
        date: '2026-02-10',
        payment: 120_600,
        interest: 600,
        principalPaid: 120_000,
        balance: 0,
      },
    ]);
  });

  it('returns an all-zero schedule for a zero principal', () => {
    const rows = amortisationSchedule({ ...mortgage, principal: 0, termMonths: 2 });
    expect(rows.map((r) => [r.payment, r.balance])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('scheduledBalanceAt', () => {
  const small = { principal: 1000, annualRateBps: 0, termMonths: 3, startDate: '2026-01-15' };

  it('is the principal before the first payment', () => {
    expect(scheduledBalanceAt(small, '2026-01-15')).toBe(1000);
    expect(scheduledBalanceAt(small, '2026-02-14')).toBe(1000);
  });

  it('is the balance after the last payment dated on or before the date', () => {
    expect(scheduledBalanceAt(small, '2026-02-15')).toBe(667);
    expect(scheduledBalanceAt(small, '2026-03-20')).toBe(334);
    expect(scheduledBalanceAt(small, '2026-04-15')).toBe(0);
    expect(scheduledBalanceAt(small, '2040-01-01')).toBe(0);
  });
});
