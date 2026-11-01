/**
 * Helpers for the repayment plan and the percentage and term inputs of the net worth forms.
 * Percentages are typed as text and become integer basis points without touching floats.
 */

export interface InstalmentRow {
  n: number;
  /** Due date (`yyyy-mm-dd`). */
  date: string;
  payment: number;
  interest: number;
  principalPaid: number;
  /** Outstanding principal after this instalment. */
  balance: number;
}

export type PercentParse = { ok: true; bps: number } | { ok: false; reason: 'empty' | 'invalid' };

/** A percentage typed with up to two decimals, "3,5" or "3.50 %", as basis points. */
export function parsePercent(raw: string): PercentParse {
  const text = raw.replace(/%/g, '').replace(/\s/g, '');
  if (text === '') return { ok: false, reason: 'empty' };
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false, reason: 'invalid' };
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(bps) ? { ok: true, bps } : { ok: false, reason: 'invalid' };
}

const decimalSeparator = (locale: string): string =>
  new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';

/** Basis points as an editable percentage in the locale's decimal style ("3,5"); no trailing zeros. */
export function bpsToInput(bps: number, locale: string): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}${decimalSeparator(locale)}${frac}`;
}

/** "3,50 %" (pt-PT) or "3.50%" (en); `trim` drops decimals that are not needed ("15 %"). */
export function formatRate(bps: number, locale: string, opts: { trim?: boolean } = {}): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: opts.trim ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(bps / 10_000);
}

/** Whole months as years and the months left over. */
export function splitTerm(totalMonths: number): { years: number; months: number } {
  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12 };
}

export type TermParse = { ok: true; months: number } | { ok: false; reason: 'empty' | 'invalid' };

/** The "Anos" and "Meses" inputs as `term_months` (1 to 600, the services' limit). */
export function parseTermInput(yearsRaw: string, monthsRaw: string): TermParse {
  const years = yearsRaw.trim();
  const months = monthsRaw.trim();
  if (years === '' && months === '') return { ok: false, reason: 'empty' };
  if ((years !== '' && !/^\d+$/.test(years)) || (months !== '' && !/^\d+$/.test(months))) {
    return { ok: false, reason: 'invalid' };
  }
  const total = Number(years || '0') * 12 + Number(months || '0');
  return total >= 1 && total <= 600
    ? { ok: true, months: total }
    : { ok: false, reason: 'invalid' };
}

/** The instalments from the current month on (at most `count`), the first flagged when it is this month's. */
export function upcomingInstalments<T extends { date: string }>(
  rows: readonly T[],
  currentMonth: string,
  count: number,
): Array<T & { thisMonth: boolean }> {
  return rows
    .filter((r) => r.date.slice(0, 7) >= currentMonth.slice(0, 7))
    .slice(0, count)
    .map((r) => ({ ...r, thisMonth: r.date.slice(0, 7) === currentMonth.slice(0, 7) }));
}

/** Instalments not yet due (dated after `today`). */
export function remainingInstalments(rows: readonly { date: string }[], today: string): number {
  return rows.filter((r) => r.date > today).length;
}

/** Share of the principal already repaid, as a whole percent (integer arithmetic, 0 to 100). */
export function repaidPercent(principal: number, balance: number): number {
  if (principal <= 0) return 0;
  const repaid = Math.min(Math.max(principal - balance, 0), principal);
  const p = BigInt(principal);
  return Number((BigInt(repaid) * 100n + p / 2n) / p);
}

/** 100 in major units (minor units of a two-decimal currency). */
const FLOOR_MINOR = 10_000;

/**
 * Whether a recorded balance has drifted from the plan: by more than 1% of the plan, but never
 * counting less than 100 in major units (so a small loan is not flagged for a few euros).
 */
export function divergesFromPlan(real: number, plan: number): boolean {
  const tolerance = Math.max(Math.round(Math.abs(plan) / 100), FLOOR_MINOR);
  return Math.abs(real - plan) > tolerance;
}
