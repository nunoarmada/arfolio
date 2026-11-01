import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { householdToday, netWorthAt, netWorthHistory } from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { moneySchema } from '../dto.js';
import { addMonths, monthStart } from '../dates.js';
import { formatMoney } from '../money.js';
import { defineTool } from './define.js';

export function registerNetWorth(server: McpServer, caller: McpCaller): void {
  defineTool(server, caller, {
    name: 'get_net_worth',
    title: 'Net worth',
    description:
      'Net worth today (assets, liabilities, net) in the household currency, as decimal strings ' +
      'plus `amount_minor`, and a month-by-month history of the last `history_months` months ' +
      '(default 12, 0 for none). Items in another currency are counted separately, never summed. ' +
      'A past month without a stored snapshot is a gap in the history, not zero.',
    access: 'read',
    input: z.strictObject({
      history_months: z.number().int().min(0).max(60).optional(),
    }),
    output: z.object({
      today: z.object({
        date: z.string(),
        currency: z.string(),
        assets: moneySchema,
        liabilities: moneySchema,
        net: moneySchema,
        foreign_currency_items: z
          .number()
          .describe('Items in another currency, listed by the app but not included in the totals'),
      }),
      history: z.array(
        z.object({
          month: z.string().describe('YYYY-MM'),
          assets: moneySchema,
          liabilities: moneySchema,
          net: moneySchema,
          change: moneySchema.nullable().describe('Net change from the previous month in the list'),
        }),
      ),
    }),
    handler: async ({ history_months }, { ctx }) => {
      const clock = await householdToday(ctx);
      const months = history_months ?? 12;
      const [now, rows] = await Promise.all([
        netWorthAt(ctx, clock.today),
        months === 0
          ? Promise.resolve([])
          : netWorthHistory(ctx, {
              from: addMonths(monthStart(clock.today), -months),
              to: clock.today,
            }),
      ]);
      const currency = now.currency;
      return {
        today: {
          date: now.date,
          currency,
          assets: formatMoney(now.assets, currency),
          liabilities: formatMoney(now.liabilities, currency),
          net: formatMoney(now.net, currency),
          foreign_currency_items: now.foreign.length,
        },
        history: rows.map((r) => ({
          month: r.month.slice(0, 7),
          assets: formatMoney(r.assets, currency),
          liabilities: formatMoney(r.liabilities, currency),
          net: formatMoney(r.net, currency),
          change: r.change === null ? null : formatMoney(r.change, currency),
        })),
      };
    },
  });
}
