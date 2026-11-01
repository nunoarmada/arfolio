/** Account types whose money you can spend (the "Saldo disponível"); for investment, its cash. */
const AVAILABLE_TYPES = new Set(['checking', 'savings', 'meal_benefit', 'investment']);

interface BalanceParts {
  type: string;
  balance?: number;
  /** Money not invested; absent on a DTO built without balances. */
  cash?: number;
  /** What a card owes; null or absent for other types. */
  owed?: number | null;
}

interface AvailableAccount extends BalanceParts {
  currency: string;
  includeInNetWorth: boolean;
}

/** An account's "Saldo": its money, the invested part left out; a card shows what it owes. */
export function shownBalance(account: BalanceParts): number {
  if (account.type === 'card') return -(account.owed ?? 0);
  return account.cash ?? account.balance ?? 0;
}

/** A sum in BigInt; a result outside the safe-integer range is rejected, never rounded. */
function safeSum(values: readonly number[]): number {
  const sum = values.reduce((acc, v) => acc + BigInt(v), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Available balance out of range');
  }
  return Number(sum);
}

/** Whether an account's money counts towards "Saldo disponível" (any currency). */
export function countsAsAvailable(a: AvailableAccount): boolean {
  return (
    AVAILABLE_TYPES.has(a.type) &&
    a.includeInNetWorth &&
    (a.type !== 'investment' || shownBalance(a) !== 0)
  );
}

/**
 * "Saldo disponível": the money in bank and meal-benefit accounts and the cash of investment
 * accounts, in the household currency. Cards, loans and accounts left out of net worth are not
 * counted; counted accounts in another currency are only counted by number.
 */
export function availableBalance(
  accounts: readonly AvailableAccount[],
  currency: string,
): { available: number; otherCurrency: number } {
  const counted = accounts.filter(countsAsAvailable);
  return {
    available: safeSum(counted.filter((a) => a.currency === currency).map(shownBalance)),
    otherCurrency: counted.filter((a) => a.currency !== currency).length,
  };
}
