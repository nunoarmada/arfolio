import { describe, expect, it } from 'vitest';
import { emergencyFundTarget, projectGoal } from './goals';

describe('projectGoal', () => {
  it('has no projection without a target (e.g. holidays)', () => {
    expect(
      projectGoal({ target: null, saved: 30_000, monthlyContribution: 5000, today: '2026-10-19' }),
    ).toEqual({ remaining: 0, months: null, expectedDate: null, progressBps: null });
  });

  it('projects months = ceil(remaining / contribution) and the first of that month', () => {
    expect(
      projectGoal({
        target: 100_000,
        saved: 25_000,
        monthlyContribution: 20_000,
        today: '2026-10-19',
      }),
    ).toEqual({ remaining: 75_000, months: 4, expectedDate: '2027-02-01', progressBps: 2500 });
  });

  it('rolls the year over', () => {
    const p = projectGoal({
      target: 100_000,
      saved: 0,
      monthlyContribution: 10_000,
      today: '2026-10-31',
    });
    expect(p.months).toBe(10);
    expect(p.expectedDate).toBe('2027-08-01');
    expect(
      projectGoal({ target: 12_000, saved: 0, monthlyContribution: 1000, today: '2026-12-05' })
        .expectedDate,
    ).toBe('2027-12-01');
  });

  it('floors the progress', () => {
    expect(
      projectGoal({ target: 3, saved: 1, monthlyContribution: 1, today: '2026-01-01' }).progressBps,
    ).toBe(3333);
  });

  it('is done when saved reaches or exceeds the target', () => {
    const done = { remaining: 0, months: 0, expectedDate: '2026-10-01', progressBps: 10_000 };
    expect(
      projectGoal({ target: 50_000, saved: 50_000, monthlyContribution: 0, today: '2026-10-19' }),
    ).toEqual(done);
    expect(
      projectGoal({ target: 50_000, saved: 80_000, monthlyContribution: 100, today: '2026-10-19' }),
    ).toEqual(done);
  });

  it('has no month count when nothing is contributed but something remains', () => {
    for (const c of [0, -500]) {
      expect(
        projectGoal({ target: 50_000, saved: 10_000, monthlyContribution: c, today: '2026-10-19' }),
      ).toEqual({ remaining: 40_000, months: null, expectedDate: null, progressBps: 2000 });
    }
  });

  it('treats a zero target as reached', () => {
    expect(
      projectGoal({ target: 0, saved: 0, monthlyContribution: 0, today: '2026-10-19' }),
    ).toEqual({ remaining: 0, months: 0, expectedDate: '2026-10-01', progressBps: 10_000 });
  });

  it('is exact for large amounts', () => {
    const p = projectGoal({
      target: 9_000_000_000_001,
      saved: 1,
      monthlyContribution: 3,
      today: '2026-01-01',
    });
    expect(p.months).toBe(3_000_000_000_000);
  });
});

describe('emergencyFundTarget', () => {
  it('is the average monthly planned expense times the months', () => {
    expect(emergencyFundTarget(180_000, 6)).toBe(1_080_000);
    expect(emergencyFundTarget(0, 6)).toBe(0);
  });
});
