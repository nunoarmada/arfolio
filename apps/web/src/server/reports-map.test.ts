import type { FactSheet } from '@arfolio/services';
import { describe, expect, it } from 'vitest';
import { toNumbers, toStoredAnomalies } from './reports-map';

const facts = (over: Partial<FactSheet> = {}): FactSheet => ({
  schemaVersion: 1,
  month: '2026-09',
  currency: 'EUR',
  totals: { income: '3000.00', expense: '2100.50', saving: '400.00', net: '899.50' },
  previous: { income: '2900.00', expense: '1950.00', saving: '350.00', net: '-600.00' },
  avg3: { income: '2950.00', expense: '2000.00', saving: '375.00', net: '575.00' },
  groups: [],
  budgetLines: [],
  recurring: { monthlyCost: '123.40', changes: [] },
  netWorth: { now: '15000.00', monthStart: '14500.00', change12m: null },
  anomalies: [{ type: 'new_recurring', name: 'Gym', amount: '29.90', cadence: 'monthly' }],
  otherCurrencyCount: 0,
  ...over,
});

describe('stored facts to view data', () => {
  it('converts the numbers and the anomalies to minor units', () => {
    expect(toNumbers(facts())).toMatchObject({
      totals: { income: 300000, net: 89950 },
      previous: { net: -60000 },
      netWorth: { now: 1500000, changeMonth: 50000, change12m: null },
      recurringMonthlyCost: 12340,
    });
    expect(toStoredAnomalies(facts())).toEqual([
      { type: 'new_recurring', name: 'Gym', amount: 2990, cadence: 'monthly' },
    ]);
  });
  it('gives null for no facts', () => {
    expect(toNumbers(null)).toBeNull();
    expect(toStoredAnomalies(null)).toBeNull();
  });
  it('gives null, never throws, for a malformed stored decimal', () => {
    const bad = facts({
      totals: { income: 'oops', expense: '1', saving: '1', net: '1' },
      anomalies: [{ type: 'new_recurring', name: 'Gym', amount: '1,5', cadence: 'monthly' }],
    });
    expect(toNumbers(bad)).toBeNull();
    expect(toStoredAnomalies(bad)).toBeNull();
  });
});
