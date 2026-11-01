import type { BudgetKind } from './actuals';

export type TransferPlanLine = {
  kind: BudgetKind;
  accountId: string | null;
  /** Planned amount for the month, positive minor units. */
  planned: number;
};

export type TransferPlan = {
  /**
   * Per non-hub account: `amount` to move from the hub = max(0, outflows - income arriving there);
   * `surplus` = max(0, income - outflows), not moved back. Ascending by account id; accounts with
   * both zero are omitted.
   */
  perAccount: Array<{ accountId: string; amount: number; surplus: number }>;
  /** Planned income landing in the hub (hub or account-less income lines). */
  hubIncome: number;
  /** Planned expenses and savings paid straight from the hub (hub or account-less lines). */
  hubOutgoing: number;
  /** `hubIncome - hubOutgoing - Σ perAccount.amount`. */
  remainingInHub: number;
  negative: boolean;
};

/**
 * Salary-style hub model: income lands in the hub, expenses and savings are paid from it or
 * moved to the account that pays them. Income arriving on another account first covers that
 * account's own outflows; lines without an account count against the hub.
 */
export function computeTransferPlan(input: {
  hubAccountId: string;
  lines: readonly TransferPlanLine[];
}): TransferPlan {
  const { hubAccountId } = input;
  let hubIncome = 0;
  let hubOutgoing = 0;
  const net = new Map<string, number>(); // outflows - income, per non-hub account

  for (const line of input.lines) {
    const { accountId } = line;
    if (accountId === null || accountId === hubAccountId) {
      if (line.kind === 'income') hubIncome += line.planned;
      else hubOutgoing += line.planned;
    } else {
      const delta = line.kind === 'income' ? -line.planned : line.planned;
      net.set(accountId, (net.get(accountId) ?? 0) + delta);
    }
  }

  const perAccount = [...net.entries()]
    .filter(([, delta]) => delta !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([accountId, delta]) => ({
      accountId,
      amount: Math.max(0, delta),
      surplus: Math.max(0, -delta),
    }));
  const remainingInHub = hubIncome - hubOutgoing - perAccount.reduce((sum, p) => sum + p.amount, 0);
  return { perAccount, hubIncome, hubOutgoing, remainingInHub, negative: remainingInHub < 0 };
}
