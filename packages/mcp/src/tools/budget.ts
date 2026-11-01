import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { budgetMonthView, budgetYearView, householdToday, listBudgets } from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { cellOut, cellSchema, moneySchema } from '../dto.js';
import { monthStart, pickBudget } from '../dates.js';
import { formatMoney } from '../money.js';
import { defineTool } from './define.js';

const KINDS = ['income', 'expense', 'saving'] as const;
const kindEnum = z.enum(KINDS);
const budgetRef = z.object({ id: z.string(), name: z.string(), start_month: z.string() });

const noDataSchema = z
  .boolean()
  .describe('Positions line whose month is unknown (no baseline snapshot): `actual` is 0');

const monthViewSchema = z.object({
  month: z.string().describe('YYYY-MM'),
  currency: z.string(),
  lines: z.array(
    z.object({
      line_id: z.string(),
      kind: kindEnum,
      name: z.string(),
      planned: moneySchema,
      actual: moneySchema.describe('Booked: expense net of refunds, income received'),
      pending: moneySchema.describe('Same formula over pending rows; not part of `actual`'),
      remaining: moneySchema.describe('planned - actual; negative when over budget'),
      percent: z
        .number()
        .nullable()
        .describe('actual / planned in percent; null if nothing planned'),
      no_data: noDataSchema,
      stale_as_of: z
        .string()
        .nullable()
        .describe('YYYY-MM-DD snapshot day of a current-month positions line over 3 days old'),
    }),
  ),
  totals: z.object({ income: cellSchema, expense: cellSchema, saving: cellSchema }),
  unallocated: z.object({ planned: moneySchema, actual: moneySchema }),
  unassigned_savings: z
    .array(
      z.object({
        account_id: z.string(),
        account_name: z.string(),
        actual: moneySchema.describe('Booked money on the account that no saving line claims'),
      }),
    )
    .describe(
      'Account flow that no saving line can be traced to: several lines sharing an account, or money on an investment account not explained by the linked positions (e.g. cash not yet invested). May be negative. Not included in totals.',
    ),
});

const monthCellSchema = z.object({ month: z.string() }).extend(cellSchema.shape);
const yearCells = z.object({
  months: z.array(monthCellSchema),
  total: cellSchema,
});
const yearViewSchema = z.object({
  currency: z.string(),
  lines: z.array(
    z.object({
      line_id: z.string(),
      kind: kindEnum,
      name: z.string(),
      total: cellSchema,
      months: z.array(monthCellSchema.extend({ no_data: noDataSchema })),
    }),
  ),
  totals: z.object({ income: yearCells, expense: yearCells, saving: yearCells }),
  unallocated: z.object({ planned: moneySchema, actual: moneySchema }),
});

export function registerBudget(server: McpServer, caller: McpCaller): void {
  defineTool(server, caller, {
    name: 'get_budget_vs_actual',
    title: 'Budget vs actual',
    description:
      'Planned versus actual amounts of the budget that covers a period, in the household ' +
      'currency (decimal strings plus `amount_minor`). With `month` (1..12, a calendar month of ' +
      '`year`) it returns that month by budget line, plus `unassigned_savings`: booked money on a ' +
      "saving line's account that no line claims. `no_data` marks a positions line whose month " +
      'cannot be known yet (its `actual` is 0, not nothing saved); `stale_as_of` gives the snapshot ' +
      'day of a current-month positions line that is over 3 days old. Without `month` it returns ' +
      'the full budget year (totals per kind by month, and per line a total and monthly cells with ' +
      '`no_data`) of the budget covering January of `year`. Defaults: the current year, and when ' +
      'neither is given the budget covering today. Returns `{ "budget": null }` when no active ' +
      'budget covers the period.',
    access: 'read',
    input: z.strictObject({
      year: z.number().int().min(1970).max(2200).optional(),
      month: z.number().int().min(1).max(12).optional(),
    }),
    output: z.object({
      budget: budgetRef.nullable(),
      month: monthViewSchema.optional(),
      year: yearViewSchema.optional(),
    }),
    handler: async ({ year, month }, { ctx }) => {
      const [clock, budgets] = await Promise.all([householdToday(ctx), listBudgets(ctx)]);
      const calendarYear = year ?? Number(clock.today.slice(0, 4));
      const period =
        month !== undefined
          ? `${calendarYear}-${String(month).padStart(2, '0')}-01`
          : year !== undefined
            ? `${calendarYear}-01-01`
            : monthStart(clock.today);
      const picked = pickBudget(budgets, period);
      if (!picked) return { budget: null };
      const ref = {
        id: picked.budget.id,
        name: picked.budget.name,
        start_month: picked.budget.startMonth,
      };

      if (month !== undefined) {
        const v = await budgetMonthView(ctx, picked.budget.id, picked.monthIndex);
        return {
          budget: ref,
          month: {
            month: v.from.slice(0, 7),
            currency: v.currency,
            lines: v.lines.map((l) => ({
              line_id: l.lineId,
              kind: l.kind,
              name: l.name,
              planned: formatMoney(l.planned, v.currency),
              actual: formatMoney(l.actual, v.currency),
              pending: formatMoney(l.pending, v.currency),
              remaining: formatMoney(l.remaining, v.currency),
              percent: l.percent,
              no_data: l.noData,
              stale_as_of: l.staleAsOf,
            })),
            totals: {
              income: cellOut(v.totals.income, v.currency),
              expense: cellOut(v.totals.expense, v.currency),
              saving: cellOut(v.totals.saving, v.currency),
            },
            unallocated: {
              planned: formatMoney(v.unallocated.planned, v.currency),
              actual: formatMoney(v.unallocated.actual, v.currency),
            },
            unassigned_savings: v.unassignedSavings.map((u) => ({
              account_id: u.accountId,
              account_name: u.accountName,
              actual: formatMoney(u.actual, v.currency),
            })),
          },
        };
      }

      const v = await budgetYearView(ctx, picked.budget.id);
      const cells = (k: (typeof KINDS)[number]) => ({
        months: v.totals[k].months.map((m) => ({
          month: v.months[m.index - 1]!.from.slice(0, 7),
          ...cellOut(m, v.currency),
        })),
        total: cellOut(v.totals[k].total, v.currency),
      });
      return {
        budget: ref,
        year: {
          currency: v.currency,
          lines: v.lines.map((l) => ({
            line_id: l.lineId,
            kind: l.kind,
            name: l.name,
            total: cellOut(l.total, v.currency),
            months: l.months.map((m) => ({
              month: v.months[m.index - 1]!.from.slice(0, 7),
              ...cellOut(m, v.currency),
              no_data: m.noData,
            })),
          })),
          totals: { income: cells('income'), expense: cells('expense'), saving: cells('saving') },
          unallocated: {
            planned: formatMoney(v.unallocated.planned, v.currency),
            actual: formatMoney(v.unallocated.actual, v.currency),
          },
        },
      };
    },
  });
}
