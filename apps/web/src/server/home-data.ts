import {
  listAccounts,
  listConnections,
  listRecurring,
  reviewCount,
  summariseMonth,
  type ServiceCtx,
} from '@arfolio/services';
import { availableBalance, countsAsAvailable, shownBalance } from '../lib/available';
import { monthEnd, monthStart, todayIn } from '../lib/dates';
import { selectUpcoming, type UpcomingView } from '../lib/home-upcoming';
import { toRecurringDto } from './budget-data';
import { loadHouseholdFormat } from './household-format';
import { toAccountDto, toConnectionDto, type AccountDto, type ConnectionDto } from './serialize';

/**
 * One loader per home block. Each reports its failure as `{ kind: 'error' }` and logs only the
 * error's name, never data, so one block failing leaves the others (and the page) standing.
 */
function fail(what: string, error: unknown): { kind: 'error' } {
  console.error(`home ${what} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
  return { kind: 'error' };
}

export type HomeReview = { kind: 'ready'; count: number } | { kind: 'error' };

export async function loadHomeReview(ctx: ServiceCtx): Promise<HomeReview> {
  try {
    return { kind: 'ready', count: await reviewCount(ctx) };
  } catch (error) {
    return fail('review count', error);
  }
}

export type HomeUpcoming =
  | {
      kind: 'ready';
      view: UpcomingView;
      today: string;
      currency: string;
      /** Detected recurring payments waiting for a decision (the "Para fazer" card counts them). */
      detected: number;
    }
  | { kind: 'error' };

/** The confirmed payments of the next seven days (and what to say when there are none). */
export async function loadHomeUpcoming(ctx: ServiceCtx): Promise<HomeUpcoming> {
  try {
    const [{ timeZone, currency }, items] = await Promise.all([
      loadHouseholdFormat(ctx),
      listRecurring(ctx),
    ]);
    const today = todayIn(timeZone);
    return {
      kind: 'ready',
      view: selectUpcoming(items.map(toRecurringDto), today, currency),
      today,
      currency,
      detected: items.filter((i) => i.status === 'detected').length,
    };
  } catch (error) {
    return fail('upcoming payments', error);
  }
}

export type HomeMonthSpend =
  { kind: 'ready'; expense: number; income: number; currency: string } | { kind: 'error' };

/**
 * This month's spending and income in the household currency: the hero shown when there is no
 * budget, and the "Fluxo do mês" KPI (income minus spending).
 */
export async function loadHomeMonthSpend(ctx: ServiceCtx): Promise<HomeMonthSpend> {
  try {
    const { timeZone, currency } = await loadHouseholdFormat(ctx);
    const today = todayIn(timeZone);
    const rows = await summariseMonth(ctx, { from: monthStart(today), to: monthEnd(today) });
    return {
      kind: 'ready',
      expense: rows.find((r) => r.currency === currency)?.expense ?? 0,
      income: rows.find((r) => r.currency === currency)?.income ?? 0,
      currency,
    };
  } catch (error) {
    return fail('month spending', error);
  }
}

/** What an account mini-card on the home needs. */
export interface HomeAccountItem {
  id: string;
  name: string;
  type: AccountDto['type'];
  institutionName: string | null;
  currency: string;
  balance: number;
  /** Counted in "Disponível" (spendable type, household currency). */
  available: boolean;
}

export type HomeAccounts =
  | {
      kind: 'ready';
      /** Open accounts: none means the household sees the "add an account" state instead. */
      count: number;
      available: number;
      /** Accounts behind `available` (the "em N contas" of the KPI). */
      availableCount: number;
      /** Every open account, for the mini-cards (the block shows the first few). */
      items: HomeAccountItem[];
      currency: string;
      /** Counted accounts in another currency: named, never added in. */
      otherCurrency: number;
    }
  | { kind: 'error' };

/** The open accounts and what is available across them (one list, which also gates the page). */
export async function loadHomeAccounts(ctx: ServiceCtx): Promise<HomeAccounts> {
  try {
    const [{ currency }, rows] = await Promise.all([loadHouseholdFormat(ctx), listAccounts(ctx)]);
    const accounts: AccountDto[] = rows.map(toAccountDto);
    return {
      kind: 'ready',
      count: accounts.length,
      ...availableBalance(accounts, currency),
      availableCount: accounts.filter((a) => countsAsAvailable(a) && a.currency === currency)
        .length,
      items: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        institutionName: a.institutionName,
        currency: a.currency,
        // The "Saldo" the accounts page shows: investment cash only, what a card owes.
        balance: shownBalance(a),
        available: countsAsAvailable(a) && a.currency === currency,
      })),
      currency,
    };
  } catch (error) {
    return fail('accounts', error);
  }
}

export type HomeConnections = { kind: 'ready'; connections: ConnectionDto[] } | { kind: 'error' };

/** Shared by the blocking-connection banner and the "Contas e ligações" strip. */
export async function loadHomeConnections(ctx: ServiceCtx, now: Date): Promise<HomeConnections> {
  try {
    return {
      kind: 'ready',
      connections: (await listConnections(ctx, { now })).map(toConnectionDto),
    };
  } catch (error) {
    return fail('connections', error);
  }
}
