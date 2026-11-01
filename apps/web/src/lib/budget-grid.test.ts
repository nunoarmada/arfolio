import { describe, expect, it } from 'vitest';
import {
  favourable,
  formatTenths,
  isOverPlan,
  monthlyAverage,
  monthsElapsed,
  parseShow,
  roundDiv,
  shareTenths,
} from './budget-grid';

describe('roundDiv', () => {
  it('rounds half away from zero', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(-4, 3)).toBe(-1);
    expect(roundDiv(10, 4)).toBe(3);
    expect(roundDiv(7, 0)).toBe(0);
  });
});

describe('averages and shares', () => {
  it('divides a yearly total by the months, never by zero', () => {
    expect(monthlyAverage(120000, 12)).toBe(10000);
    expect(monthlyAverage(100, 12)).toBe(8);
    expect(monthlyAverage(100, 0)).toBe(100);
  });

  it('gives a share in tenths of a percent', () => {
    expect(shareTenths(1, 3)).toBe(333);
    expect(shareTenths(2, 3)).toBe(667);
    expect(shareTenths(5, 0)).toBeNull();
    expect(shareTenths(0, 10)).toBe(0);
  });

  it('formats tenths in the household locale', () => {
    expect(formatTenths(123, 'en')).toBe('12.3%');
    expect(formatTenths(123, 'pt-PT').replace(/\s/g, ' ')).toMatch(/^12,3 ?%$/);
  });
});

describe('favourable', () => {
  it('is positive when better than planned for every kind', () => {
    expect(favourable('expense', 1000, 800)).toBe(200);
    expect(favourable('expense', 1000, 1200)).toBe(-200);
    expect(favourable('income', 1000, 1300)).toBe(300);
    expect(favourable('saving', 1000, 400)).toBe(-600);
  });
  it('only expenses can be over plan', () => {
    expect(isOverPlan('expense', 100, 101)).toBe(true);
    expect(isOverPlan('expense', 100, 100)).toBe(false);
    expect(isOverPlan('income', 100, 500)).toBe(false);
  });
});

describe('monthsElapsed', () => {
  it('counts the current month and stays within 1..12', () => {
    expect(monthsElapsed('2026-10-01', '2026-10-01')).toBe(1);
    expect(monthsElapsed('2026-10-01', '2027-01-01')).toBe(4);
    expect(monthsElapsed('2026-10-01', '2029-01-01')).toBe(12);
    expect(monthsElapsed('2026-10-01', '2026-06-01')).toBe(1);
  });
  it('parses the view toggle with a safe default', () => {
    expect(parseShow('actual')).toBe('actual');
    expect(parseShow('nope')).toBe('planned');
    expect(parseShow(undefined)).toBe('planned');
  });
});
