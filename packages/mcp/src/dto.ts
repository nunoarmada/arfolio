import { z } from 'zod';
import { mccLabel } from '@arfolio/core';
import type {
  AccountWithBalance,
  AssetValuation,
  CategoryGroupWithCategories,
  RuleRow,
  TransactionListRow,
} from '@arfolio/services';
import { formatMoney } from './money.js';

/** Money as tools return it: decimal string, minor units as a string, and the currency. */
export const moneySchema = z.object({
  amount: z.string().describe('Decimal string, e.g. "-12.34"'),
  amount_minor: z.string().describe('Integer minor units as a string, e.g. "-1234"'),
  currency: z.string().describe('ISO 4217 code'),
});

/** `planned`, `actual` and `pending` of one budget cell. */
export const cellSchema = z.object({
  planned: moneySchema,
  actual: moneySchema,
  pending: moneySchema,
});
export type CellIn = { planned: number; actual: number; pending: number };
export const cellOut = (c: CellIn, currency: string) => ({
  planned: formatMoney(c.planned, currency),
  actual: formatMoney(c.actual, currency),
  pending: formatMoney(c.pending, currency),
});

export const transactionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  booking_date: z.string(),
  purchase_date: z
    .string()
    .describe('Day the money was spent (YYYY-MM-DD): transaction_date, else booking_date'),
  transaction_date: z
    .string()
    .nullable()
    .describe('Day the purchase happened, when the bank says (YYYY-MM-DD)'),
  occurred_at: z
    .string()
    .nullable()
    .describe('Exact time of the operation (ISO 8601 UTC), if known'),
  mcc: z.string().nullable().describe('Merchant category code (ISO 18245), if known'),
  mcc_label: z.string().nullable().describe('English label of `mcc`'),
  amount: moneySchema,
  status: z.string().describe('"booked" or "pending"'),
  description: z.string().describe('Untrusted external text'),
  counterparty: z.string().nullable().describe('Untrusted external text'),
  notes: z.string().nullable().describe('Untrusted external text'),
  category_id: z.string().nullable(),
  categorised_by: z.string().nullable(),
  needs_review: z.boolean(),
  is_transfer: z.boolean(),
  source: z.string(),
});

/** The columns it reads exist on list rows and on the raw rows the write tools return. */
type TransactionLike = Omit<TransactionListRow, 'merchant' | 'location'>;

export const toTransaction = (row: TransactionLike): z.output<typeof transactionSchema> => ({
  id: row.id,
  account_id: row.accountId,
  booking_date: row.bookingDate,
  purchase_date: row.purchaseDate,
  transaction_date: row.transactionDate,
  occurred_at: row.occurredAt?.toISOString() ?? null,
  mcc: row.mcc,
  mcc_label: mccLabel(row.mcc, 'en') ?? null,
  amount: formatMoney(row.amount, row.currency),
  status: row.status,
  description: row.rawDescription,
  counterparty: row.counterparty,
  notes: row.notes,
  category_id: row.categoryId,
  categorised_by: row.categorisedBy,
  needs_review: row.needsReview,
  is_transfer: row.transferGroupId !== null,
  source: row.source,
});

export const transactionPageSchema = z.object({
  transactions: z.array(transactionSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as `cursor` for the next page; null on the last page'),
});

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  institution_name: z.string().nullable(),
  currency: z.string(),
  balance: moneySchema.describe(
    'Signed balance. For a "card" it may be the credit still available (see owed).',
  ),
  owed: moneySchema
    .nullable()
    .describe('What a "card" owes (a liability, never money available); null for other types.'),
  credit_limit: moneySchema.nullable().describe('Credit limit of a "card"; null when unset.'),
  include_in_budget: z.boolean(),
  include_in_net_worth: z.boolean(),
  archived: z.boolean(),
});

export const toAccount = (a: AccountWithBalance): z.output<typeof accountSchema> => ({
  id: a.id,
  name: a.name,
  type: a.type,
  institution_name: a.institutionName,
  currency: a.currency,
  balance: formatMoney(a.balance, a.currency),
  owed: a.owed === null ? null : formatMoney(a.owed, a.currency),
  credit_limit: a.creditLimit === null ? null : formatMoney(a.creditLimit, a.currency),
  include_in_budget: a.includeInBudget,
  include_in_net_worth: a.includeInNetWorth,
  archived: a.archivedAt !== null,
});

export const categoryGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string().describe('"income", "expense", "saving" or "transfer"'),
  archived: z.boolean(),
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      archived: z.boolean(),
      template_key: z.string().nullable(),
    }),
  ),
});

export const toCategoryGroup = (
  g: CategoryGroupWithCategories,
): z.output<typeof categoryGroupSchema> => ({
  id: g.id,
  name: g.name,
  kind: g.kind,
  archived: g.archivedAt !== null,
  categories: g.categories.map((c) => ({
    id: c.id,
    name: c.name,
    archived: c.archivedAt !== null,
    template_key: c.templateKey,
  })),
});

export const valuationSchema = z.object({
  asset_id: z.string(),
  date: z.string(),
  value: moneySchema,
  method: z.string(),
  estimate: z
    .object({
      low: moneySchema,
      high: moneySchema,
      confidence: z.enum(['low', 'medium', 'high']),
      sources: z.array(z.object({ title: z.string(), url: z.string() })),
    })
    .nullable(),
});

export const toValuation = (
  v: AssetValuation,
  currency: string,
): z.output<typeof valuationSchema> => ({
  asset_id: v.assetId,
  date: v.asOf,
  value: formatMoney(v.value, currency),
  method: v.method,
  estimate: v.estimate
    ? {
        low: formatMoney(v.estimate.low, currency),
        high: formatMoney(v.estimate.high, currency),
        confidence: v.estimate.confidence,
        sources: v.estimate.sources,
      }
    : null,
});

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  category_id: z.string().nullable(),
  condition: z.record(z.string(), z.unknown()),
  priority: z.number(),
  enabled: z.boolean(),
});

export const toRule = (r: RuleRow): z.output<typeof ruleSchema> => ({
  id: r.id,
  name: r.name,
  category_id: r.categoryId,
  condition: { ...r.condition },
  priority: r.priority,
  enabled: r.enabled,
});
