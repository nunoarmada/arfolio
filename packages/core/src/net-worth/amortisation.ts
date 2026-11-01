/**
 * Fixed-rate annuity loans with integer minor units. The payment formula
 *   P * r / (1 - (1 + r)^-n),  r = annualRateBps / 120000 (monthly rate)
 * is evaluated as an exact BigInt rational (r = a/b, so (1 + r)^n = (a + b)^n / b^n), then rounded
 * once, half away from zero: no floating point and no accumulated precision loss.
 * Monthly interest on the running balance is round(balance * bps / 120000), half away from zero.
 */

const BPS_PER_MONTH_DENOMINATOR = 120_000n;

export interface AmortisationParams {
  /** Borrowed amount in minor units (integer, >= 0). */
  principal: number;
  /** Nominal annual rate in basis points (integer, >= 0). */
  annualRateBps: number;
  /** Number of monthly instalments (integer, >= 1). */
  termMonths: number;
  /** Loan start (YYYY-MM-DD); instalment n falls on startDate + n months. */
  startDate: string;
}

export interface AmortisationRow {
  /** 1-based instalment number. */
  n: number;
  date: string;
  payment: number;
  interest: number;
  principalPaid: number;
  /** Outstanding principal after this instalment. */
  balance: number;
}

/** `numerator / denominator` (both BigInt, denominator > 0) rounded half away from zero. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const abs = numerator < 0n ? -numerator : numerator;
  const q = (abs * 2n + denominator) / (denominator * 2n);
  return numerator < 0n ? -q : q;
}

function validate(principal: number, annualRateBps: number, termMonths: number): void {
  if (!Number.isSafeInteger(principal) || principal < 0) {
    throw new RangeError(`principal must be a non-negative integer: ${principal}`);
  }
  if (!Number.isSafeInteger(annualRateBps) || annualRateBps < 0) {
    throw new RangeError(`annualRateBps must be a non-negative integer: ${annualRateBps}`);
  }
  if (!Number.isSafeInteger(termMonths) || termMonths < 1) {
    throw new RangeError(`termMonths must be an integer >= 1: ${termMonths}`);
  }
}

/**
 * Level monthly payment in minor units. At 0% the payment is the principal divided by the term,
 * rounded down, so the last instalment absorbs the remainder.
 */
export function annuityPayment(
  principal: number,
  annualRateBps: number,
  termMonths: number,
): number {
  validate(principal, annualRateBps, termMonths);
  const p = BigInt(principal);
  const n = BigInt(termMonths);
  if (annualRateBps === 0) return Number(p / n);
  const a = BigInt(annualRateBps);
  const b = BPS_PER_MONTH_DENOMINATOR;
  const growth = (a + b) ** n; // (b + a)^n, i.e. (1 + r)^n * b^n
  const base = b ** n;
  // P * r * (1 + r)^n / ((1 + r)^n - 1) with r = a / b
  return Number(roundDiv(p * a * growth, b * (growth - base)));
}

/** startDate + `months` calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Full schedule; the last instalment pays off whatever balance remains, so it ends at exactly 0. */
export function amortisationSchedule(params: AmortisationParams): AmortisationRow[] {
  const { principal, annualRateBps, termMonths, startDate } = params;
  const payment = annuityPayment(principal, annualRateBps, termMonths);
  const rows: AmortisationRow[] = [];
  let balance = BigInt(principal);
  for (let n = 1; n <= termMonths; n++) {
    const interest = roundDiv(balance * BigInt(annualRateBps), BPS_PER_MONTH_DENOMINATOR);
    const scheduled = BigInt(payment);
    const isLast = n === termMonths;
    // Never overpay: cap at the balance plus interest (also settles the loan on the last row).
    const due = balance + interest;
    const paid = isLast || scheduled > due ? due : scheduled;
    const principalPaid = paid - interest;
    balance -= principalPaid;
    rows.push({
      n,
      date: addMonths(startDate, n),
      payment: Number(paid),
      interest: Number(interest),
      principalPaid: Number(principalPaid),
      balance: Number(balance),
    });
  }
  return rows;
}

/** Balance after the last instalment dated on or before `date`; the principal before the first. */
export function scheduledBalanceAt(params: AmortisationParams, date: string): number {
  let balance = params.principal;
  for (const row of amortisationSchedule(params)) {
    if (row.date > date) break;
    balance = row.balance;
  }
  return balance;
}
