import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  budgetMonthView,
  householdToday,
  listBudgets,
  netWorthAt,
  reviewCount,
  summariseMonth,
} from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { cellSchema, cellOut, moneySchema } from '../dto.js';
import { monthEnd, monthStart, pickBudget } from '../dates.js';
import { formatMoney } from '../money.js';
import { defineTool } from './define.js';

const KINDS = ['income', 'expense', 'saving'] as const;

export function registerOverview(server: McpServer, caller: McpCaller): void {
  defineTool(server, caller, {
    name: 'get_overview',
    title: 'Household overview',
    description:
      'Snapshot of the household for one month (default: the current month): income and spending ' +
      'per currency (transfers between accounts excluded), how many transactions await review, ' +
      "the budget status for that month if a budget covers it, and today's net worth. Amounts " +
      'are decimal strings with a currency, plus `amount_minor` (integer minor units as a string).',
    access: 'read',
    input: z.strictObject({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM')
        .optional()
        .describe('Month as YYYY-MM; defaults to the current month in the household time zone'),
    }),
    output: z.object({
      month: z.string(),
      spending: z.array(
        z.object({
          currency: z.string(),
          income: moneySchema,
          expense: moneySchema.describe('Spending as a positive amount, net of refunds'),
          transactions: z.number().describe('Booked, non-transfer rows counted'),
          uncategorised: z.number(),
        }),
      ),
      review_count: z.number().describe('Transactions waiting for review'),
      budget: z
        .object({
          id: z.string(),
          name: z.string(),
          start_month: z.string(),
          month_index: z.number().describe('1..12 within the budget year'),
          currency: z.string(),
          totals: z.object({ income: cellSchema, expense: cellSchema, saving: cellSchema }),
          unallocated: z.object({ planned: moneySchema, actual: moneySchema }),
        })
        .nullable()
        .describe('Null when no active budget covers the month'),
      net_worth: z.object({
        date: z.string(),
        currency: z.string(),
        assets: moneySchema,
        liabilities: moneySchema,
        net: moneySchema,
      }),
    }),
    handler: async ({ month }, { ctx }) => {
      const clock = await householdToday(ctx);
      const first = month ? `${month}-01` : monthStart(clock.today);
      const [spending, review, budgets, worth] = await Promise.all([
        summariseMonth(ctx, { from: first, to: monthEnd(first) }),
        reviewCount(ctx),
        listBudgets(ctx),
        netWorthAt(ctx, clock.today),
      ]);
      const picked = pickBudget(budgets, first);
      const view = picked ? await budgetMonthView(ctx, picked.budget.id, picked.monthIndex) : null;
      return {
        month: first.slice(0, 7),
        spending: spending.map((r) => ({
          currency: r.currency,
          income: formatMoney(r.income, r.currency),
          expense: formatMoney(r.expense, r.currency),
          transactions: r.count,
          uncategorised: r.uncategorised,
        })),
        review_count: review,
        budget:
          picked && view
            ? {
                id: picked.budget.id,
                name: picked.budget.name,
                start_month: picked.budget.startMonth,
                month_index: picked.monthIndex,
                currency: view.currency,
                totals: Object.fromEntries(
                  KINDS.map((k) => [k, cellOut(view.totals[k], view.currency)]),
                ) as Record<(typeof KINDS)[number], ReturnType<typeof cellOut>>,
                unallocated: {
                  planned: formatMoney(view.unallocated.planned, view.currency),
                  actual: formatMoney(view.unallocated.actual, view.currency),
                },
              }
            : null,
        net_worth: {
          date: worth.date,
          currency: worth.currency,
          assets: formatMoney(worth.assets, worth.currency),
          liabilities: formatMoney(worth.liabilities, worth.currency),
          net: formatMoney(worth.net, worth.currency),
        },
      };
    },
  });
}
