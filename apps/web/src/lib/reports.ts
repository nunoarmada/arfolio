/**
 * Pure helpers of Análises › Relatórios: which months are reportable, the rows of the list,
 * the anomaly view model and what a member may do. Client-safe: no database, no environment.
 */
import { minorDigits } from '@arfolio/core';
import type { Anomaly } from '@arfolio/services';
import { addMonths, monthEnd, monthStart } from './dates';
import { txHref } from './insights-chart';

export type ReportStatus = 'pending' | 'ready' | 'failed' | 'skipped';
/** What a month's row looks like in the list: a stored status, or no row at all. */
export type RowStatus = ReportStatus | 'none';

/** Polling of a pending report: every 10 s, at most 12 times (2 minutes). */
export const POLL_INTERVAL_MS = 10_000;
export const POLL_MAX_TICKS = 12;
/** A month without a stored report is only reachable this far back. */
export const MAX_AGE_MONTHS = 24;
/** The list always offers this many closed months, with or without a report. */
export const RECENT_MONTHS = 3;
export const LIST_PAGE_SIZE = 24;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `yyyy-mm` of the month before today's (the only month a report can be generated for). */
export function lastClosedMonth(today: string): string {
  return addMonths(today, -1).slice(0, 7);
}

/** Whether `raw` is a well-formed `yyyy-mm` for a month that has already ended. */
export function isClosedMonth(raw: string, today: string): boolean {
  return MONTH.test(raw) && raw < today.slice(0, 7);
}

/** True when the month is too old to be opened without a stored report. */
export function isTooOld(month: string, today: string): boolean {
  return month < addMonths(today, -MAX_AGE_MONTHS).slice(0, 7);
}

export const firstDay = (month: string): string => monthStart(`${month}-01`);
export const monthBounds = (month: string): { from: string; to: string } => ({
  from: `${month}-01`,
  to: monthEnd(`${month}-01`),
});

/** A decimal string from the services ("-1234.56", "1234" for JPY) as safe integer minor units. */
export function decimalToMinor(decimal: string, currency: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) throw new RangeError('decimalToMinor: not a decimal string');
  const digits = minorDigits(currency);
  const fraction = (match[3] ?? '').padEnd(digits, '0').slice(0, digits);
  const value = Number(`${match[2]}${fraction}`);
  if (!Number.isSafeInteger(value)) throw new RangeError('decimalToMinor: amount too large');
  return match[1] === '-' ? -value : value;
}

// ---------------------------------------------------------------------------------------------
// List rows

export interface ListRowInput {
  month: string;
  status: ReportStatus;
}

export interface ListRow {
  month: string;
  status: RowStatus;
}

/**
 * The stored reports plus, on the first page, the last closed months that have none, newest
 * first. A later page (`recent` false) is the stored reports only.
 */
export function buildListRows(
  reports: readonly ListRowInput[],
  today: string,
  recent: boolean,
): ListRow[] {
  const rows = new Map<string, ListRow>(reports.map((r) => [r.month, r]));
  if (recent) {
    for (let i = 1; i <= RECENT_MONTHS; i += 1) {
      const month = addMonths(today, -i).slice(0, 7);
      if (!rows.has(month)) rows.set(month, { month, status: 'none' });
    }
  }
  return [...rows.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}

/** Months whose anomaly count may be computed live (no stored facts): the recent ones only. */
export function isRecentMonth(month: string, today: string): boolean {
  return month >= addMonths(today, -RECENT_MONTHS).slice(0, 7) && month < today.slice(0, 7);
}

// ---------------------------------------------------------------------------------------------
// Actions

export type Role = 'owner' | 'member' | 'viewer';

export interface ActionRules {
  role: Role;
  aiAvailable: boolean;
  aiEnabled: boolean;
  month: string;
  lastClosed: string;
  status: RowStatus;
  regenerations: number;
  maxRegenerations: number;
}

export interface ActionState {
  /** The person may ask for this month's report now (limit not considered). */
  allowed: boolean;
  /** Regenerations left; the first generation of a month without a row is free. */
  left: number;
  /** A finished report that cannot be generated again. */
  limitReached: boolean;
}

export function actionState(r: ActionRules): ActionState {
  const left = Math.max(0, r.maxRegenerations - r.regenerations);
  const hasRow = r.status !== 'none';
  return {
    allowed:
      r.role !== 'viewer' &&
      r.aiAvailable &&
      r.aiEnabled &&
      r.month === r.lastClosed &&
      r.status !== 'pending',
    left: hasRow ? left : r.maxRegenerations,
    limitReached: hasRow && left === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Anomalies (amounts in minor units, ready for MoneyAmount)

export type AnomalyDto =
  | { type: 'category_spike'; categoryId: string; name: string; amount: number; baseline: number }
  | { type: 'budget_overrun'; lineId: string; name: string; actual: number; planned: number }
  | { type: 'new_recurring'; name: string; amount: number; cadence: string }
  | { type: 'recurring_price_change'; name: string; before: number; after: number }
  | {
      type: 'large_transaction';
      categoryId?: string;
      categoryName: string;
      amount: number;
      date: string;
    };

export function toAnomalyDto(a: Anomaly, currency: string): AnomalyDto {
  const m = (d: string) => decimalToMinor(d, currency);
  switch (a.type) {
    case 'category_spike':
      return { ...a, amount: m(a.amount), baseline: m(a.baseline) };
    case 'budget_overrun':
      return { ...a, actual: m(a.actual), planned: m(a.planned) };
    case 'new_recurring':
      return { ...a, amount: m(a.amount) };
    case 'recurring_price_change':
      return { ...a, before: m(a.before), after: m(a.after) };
    case 'large_transaction':
      return { ...a, amount: m(a.amount) };
  }
}

export type AnomalyLink = { kind: 'movements' | 'line' | 'subscriptions'; href: string };

/**
 * Where an anomaly's "see more" link goes. A budget line is only editable by owners and members,
 * so a viewer gets no link for an overrun.
 */
export function anomalyLink(a: AnomalyDto, month: string, role: Role): AnomalyLink | null {
  switch (a.type) {
    case 'category_spike':
      return {
        kind: 'movements',
        href: txHref({ ...monthBounds(month), categoryIds: [a.categoryId], direction: 'out' }),
      };
    case 'large_transaction':
      return {
        kind: 'movements',
        href: txHref({
          from: a.date,
          to: a.date,
          direction: 'out',
          ...(a.categoryId ? { categoryIds: [a.categoryId] } : {}),
        }),
      };
    case 'budget_overrun':
      return role === 'viewer'
        ? null
        : {
            kind: 'line',
            href: `/budget/lines/${a.lineId}?back=${encodeURIComponent(`/insights/reports/${month}`)}`,
          };
    case 'new_recurring':
    case 'recurring_price_change':
      return { kind: 'subscriptions', href: '/budget/subscriptions' };
  }
}

/** Whether the "back" target of the budget line editor may be a report page. */
export const REPORT_BACK = /^\/insights\/reports\/\d{4}-(0[1-9]|1[0-2])$/;
