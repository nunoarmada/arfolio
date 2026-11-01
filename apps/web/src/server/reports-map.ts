import type { FactSheet } from '@arfolio/services';
import { decimalToMinor, toAnomalyDto, type AnomalyDto } from '../lib/reports';

export interface Money4 {
  income: number;
  expense: number;
  saving: number;
  net: number;
}

export interface NumbersDto {
  currency: string;
  totals: Money4;
  previous: Money4;
  avg3: Money4;
  netWorth: { now: number; changeMonth: number; change12m: number | null };
  recurringMonthlyCost: number;
  otherCurrencyCount: number;
}

function compute(f: FactSheet): NumbersDto {
  const m = (d: string) => decimalToMinor(d, f.currency);
  const four = (t: { income: string; expense: string; saving: string; net: string }): Money4 => ({
    income: m(t.income),
    expense: m(t.expense),
    saving: m(t.saving),
    net: m(t.net),
  });
  const now = m(f.netWorth.now);
  return {
    currency: f.currency,
    totals: four(f.totals),
    previous: four(f.previous),
    avg3: four(f.avg3),
    netWorth: {
      now,
      changeMonth: now - m(f.netWorth.monthStart),
      change12m: f.netWorth.change12m === null ? null : m(f.netWorth.change12m),
    },
    recurringMonthlyCost: m(f.recurring.monthlyCost),
    otherCurrencyCount: f.otherCurrencyCount,
  };
}

/**
 * The numbers table of stored facts, or null when there are none or a stored decimal cannot be
 * read (the page then shows the report without it rather than failing).
 */
export function toNumbers(facts: FactSheet | null): NumbersDto | null {
  if (!facts) return null;
  try {
    return compute(facts);
  } catch {
    return null;
  }
}

/** The stored anomalies in minor units, or null (so the page computes them live) when unreadable. */
export function toStoredAnomalies(facts: FactSheet | null): AnomalyDto[] | null {
  if (!facts) return null;
  try {
    return facts.anomalies.map((a) => toAnomalyDto(a, facts.currency));
  } catch {
    return null;
  }
}
