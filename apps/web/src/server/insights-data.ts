import { cashFlow, monthlyTrends, spendingByGroup, type ServiceCtx } from '@arfolio/services';
import type { TrendRow } from '../lib/insights-chart';
import { loadHouseholdFormat } from './household-format';
import { loadLookups } from './lookups';
import type { CategoryDto } from './serialize';

/**
 * One loader per section of Análises. Each reports its failure as `{ kind: 'error' }` and logs
 * only the error's name, never data, so one section failing leaves the others (and the page)
 * standing.
 */
function fail(what: string, error: unknown): { kind: 'error' } {
  console.error(`insights ${what} failed: ${error instanceof Error ? error.name : 'unknown'}`);
  return { kind: 'error' };
}

// ---------------------------------------------------------------------------------------------
// Spending by group

export interface SpendingCategoryDto {
  categoryId: string | null;
  name: string;
  amount: number;
  /** For the icon; null when the category cannot be resolved. */
  category: CategoryDto | null;
}
export interface SpendingGroupDto {
  groupId: string;
  name: string;
  amount: number;
  shareBps: number;
  /** The group's stable colour slot (1-7). */
  slot: number;
  categories: SpendingCategoryDto[];
}
export type InsightsSpending =
  | {
      kind: 'ready';
      currency: string;
      total: number;
      uncategorised: number;
      foreignCount: number;
      groups: SpendingGroupDto[];
    }
  | { kind: 'error' };

export async function loadInsightsSpending(
  ctx: ServiceCtx,
  range: { from: string; to: string },
): Promise<InsightsSpending> {
  try {
    const [data, lookups] = await Promise.all([spendingByGroup(ctx, range), loadLookups(ctx)]);
    const slotOf = new Map(lookups.groups.map((g) => [g.id, g.slot]));
    const categoryOf = new Map(lookups.categories.map((c) => [c.id, c]));
    return {
      kind: 'ready',
      currency: data.currency,
      total: data.total,
      uncategorised: data.uncategorised,
      foreignCount: data.foreignCount,
      groups: data.groups.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        amount: g.amount,
        shareBps: g.share_bps,
        slot: slotOf.get(g.groupId) ?? 1,
        categories: g.categories.map((c) => ({
          categoryId: c.categoryId,
          name: c.name,
          amount: c.amount,
          category: c.categoryId ? (categoryOf.get(c.categoryId) ?? null) : null,
        })),
      })),
    };
  } catch (error) {
    return fail('spending', error);
  }
}

// ---------------------------------------------------------------------------------------------
// Trends

export type InsightsTrends =
  | {
      kind: 'ready';
      /** Oldest first, the leading months with no data already dropped by the page. */
      rows: TrendRow[];
    }
  | { kind: 'error' };

/** The 12 months ending at `end` (`yyyy-mm-01`), zero-filled; months are `yyyy-mm-01`. */
export async function loadInsightsTrends(ctx: ServiceCtx, end: string): Promise<InsightsTrends> {
  try {
    const rows = await monthlyTrends(ctx, { months: 12, endMonth: end.slice(0, 7) });
    return { kind: 'ready', rows: rows.map((r) => ({ ...r, month: `${r.month}-01` })) };
  } catch (error) {
    return fail('trends', error);
  }
}

// ---------------------------------------------------------------------------------------------
// Cash flow

export interface CashFlowAccountDto {
  accountId: string;
  name: string;
  inflow: number;
  outflow: number;
}
export type InsightsCashFlow =
  | {
      kind: 'ready';
      currency: string;
      inflow: number;
      outflow: number;
      net: number;
      /** Months are `yyyy-mm-01`. */
      byMonth: Array<{ month: string; inflow: number; outflow: number; net: number }>;
      /** Accounts with money in or out in the period, largest outflow first. */
      byAccount: CashFlowAccountDto[];
      /** Active accounts in the household currency that had no money in or out. */
      idleAccounts: number;
      /** The accounts the filter offers: active and in the household currency. */
      accounts: Array<{ id: string; name: string }>;
      /** True when an active account in another currency is left out of every figure. */
      hasForeignAccounts: boolean;
      /** The account the figures are for; null for all (an unknown id is ignored). */
      account: string | null;
      foreignCount: number;
    }
  | { kind: 'error' };

export async function loadInsightsCashFlow(
  ctx: ServiceCtx,
  range: { from: string; to: string },
  accountId: string | null,
): Promise<InsightsCashFlow> {
  try {
    const [lookups, { currency: householdCurrency }] = await Promise.all([
      loadLookups(ctx),
      loadHouseholdFormat(ctx),
    ]);
    const active = lookups.accounts.filter((a) => !a.archived);
    // Accounts in another currency have no rows in any figure, so the filter does not offer them.
    const accounts = active.filter((a) => a.currency === householdCurrency);
    const account = accountId && accounts.some((a) => a.id === accountId) ? accountId : null;
    const data = await cashFlow(ctx, { ...range, ...(account ? { accountIds: [account] } : {}) });
    const names = new Map(lookups.accounts.map((a) => [a.id, a.name]));
    const byAccount = data.byAccount
      .filter((r) => r.inflow !== 0 || r.outflow !== 0)
      .map((r) => ({ ...r, name: names.get(r.accountId) ?? '' }));
    const used = new Set(byAccount.map((r) => r.accountId));
    return {
      kind: 'ready',
      currency: householdCurrency,
      inflow: data.inflow,
      outflow: data.outflow,
      net: data.net,
      byMonth: data.byMonth.map((m) => ({ ...m, month: `${m.month}-01` })),
      byAccount,
      idleAccounts: accounts.filter((a) => !used.has(a.id)).length,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      hasForeignAccounts: active.some((a) => a.currency !== householdCurrency),
      account,
      foreignCount: data.foreignCount,
    };
  } catch (error) {
    return fail('cash flow', error);
  }
}
