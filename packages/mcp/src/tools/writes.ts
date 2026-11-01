import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  addAssetValuation,
  calendarDate,
  createRule,
  listAssets,
  householdToday,
  NotFoundError,
} from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { ruleSchema, toRule, toValuation, valuationSchema } from '../dto.js';
import { formatMoney, parseMoneyInput } from '../money.js';
import { defineTool } from './define.js';

const needle = z.string().max(200);
const amountText = z.string().max(32);

/**
 * The rule condition as a tool takes it: the service's keys, but amounts are decimal strings. The
 * service validates the converted condition (not empty, min <= max, pattern, lengths).
 */
const conditionInput = z.strictObject({
  descriptionContains: needle.optional(),
  descriptionPattern: needle.optional(),
  counterpartyContains: needle.optional(),
  amountMin: amountText
    .optional()
    .describe('Decimal string in the household currency, e.g. "-250.50"'),
  amountMax: amountText.optional().describe('Decimal string in the household currency, e.g. "-10"'),
  direction: z.enum(['in', 'out']).optional(),
  accountIds: z.array(z.uuid()).min(1).max(100).optional(),
});

export function registerAssetAndRuleTools(server: McpServer, caller: McpCaller): void {
  defineTool(server, caller, {
    name: 'update_asset_valuation',
    title: 'Record an asset value',
    description:
      'Records the value of an asset (a home, a car, ...) on a date. `value` is a plain decimal ' +
      'string, zero or more, in the asset’s currency: "250000.00" (no thousands separators, comma ' +
      'decimals or exponent). A second value for the same date replaces the first. Net worth ' +
      'history from that month on is recalculated. Recorded in the audit log.',
    access: 'write',
    input: z.strictObject({
      asset_id: z.string().max(64),
      value: z.string().max(32).describe('Decimal string, e.g. "180000.50"'),
      date: calendarDate.describe('The day the value applies to, YYYY-MM-DD'),
    }),
    output: z.object({ valuation: valuationSchema }),
    handler: async (a, { ctx, audit }) => {
      // A separate read before the write: the currency only decides how the text is parsed, and the
      // write re-checks the asset inside its own transaction, so a race gives not_found, never a wrong write.
      // Disposed assets are listed too: the service refuses a valuation on or after the disposal day.
      const asset = (await listAssets(ctx, { includeArchived: true, includeDisposed: true })).find(
        (x) => x.id === a.asset_id,
      );
      if (!asset) throw new NotFoundError('Asset');
      const row = await addAssetValuation(
        ctx,
        asset.id,
        { asOf: a.date, value: parseMoneyInput(a.value, asset.currency) },
        { onCommit: (tx) => audit(tx, 'asset.valuation', 'asset', asset.id) },
      );
      return { valuation: toValuation(row, asset.currency) };
    },
  });

  defineTool(server, caller, {
    name: 'create_rule',
    title: 'Create a categorisation rule',
    description:
      'Creates a rule that puts matching future transactions in a category. `condition` needs at ' +
      'least one of: descriptionContains, descriptionPattern (wildcards), counterpartyContains, ' +
      'amountMin / amountMax (decimal strings in the household currency, like "-12.34", ' +
      'negative for money out), ' +
      'direction ("in" | "out"), accountIds (list of account ids). All given parts must match. ' +
      'Recorded in the audit log.',
    access: 'write',
    input: z.strictObject({
      name: z.string().trim().min(1).max(120),
      category_id: z.string().max(64),
      condition: conditionInput,
    }),
    output: z.object({ rule: ruleSchema }),
    handler: async (a, { ctx, audit }) => {
      const { currency } = await householdToday(ctx);
      const { amountMin, amountMax, ...rest } = a.condition;
      const row = await createRule(
        ctx,
        {
          name: a.name,
          categoryId: a.category_id,
          condition: {
            ...rest,
            ...(amountMin !== undefined && { amountMin: parseMoneyInput(amountMin, currency) }),
            ...(amountMax !== undefined && { amountMax: parseMoneyInput(amountMax, currency) }),
          },
        },
        { onCommit: (tx, r) => audit(tx, 'rule.create', 'rule', r.id) },
      );
      const out = toRule(row);
      const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v, currency).amount : v);
      out.condition = {
        ...out.condition,
        ...('amountMin' in out.condition && { amountMin: money(out.condition.amountMin) }),
        ...('amountMax' in out.condition && { amountMax: money(out.condition.amountMax) }),
      };
      return { rule: out };
    },
  });
}
