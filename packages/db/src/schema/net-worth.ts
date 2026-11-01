import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';
import { budgetLine } from './budgets.js';
import { transaction } from './transactions.js';

// RLS (policy + grants) and the updated_at triggers live in the custom SQL migration, not here.
// Children use composite FKs (x_id, household_id) onto a unique (id, household_id), so a row can
// never point at another household's data. Nullable references use MATCH SIMPLE (null skips the
// check). `ON DELETE SET NULL` on those composite FKs is hand-edited in the migration to the
// Postgres 15+ column-list form `SET NULL (x_id)`, otherwise it would also null household_id.
// All money is integer minor units in the row's own currency; nothing here is ever a float.

export const ASSET_KINDS = ['real_estate', 'vehicle', 'investment', 'cash', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const VALUATION_METHODS = ['manual', 'connector', 'depreciation', 'import', 'ai'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];
/** An AI valuation's range and the evidence behind it, stored beside the point value. */
export type ValuationEstimate = {
  low: number;
  high: number;
  confidence: 'low' | 'medium' | 'high';
  sources: Array<{ title: string; url: string }>;
};
export const DISPOSAL_KINDS = ['sold', 'written_off'] as const;
export type DisposalKind = (typeof DISPOSAL_KINDS)[number];
export const LIABILITY_KINDS = ['mortgage', 'loan', 'debt', 'card', 'other'] as const;
export type LiabilityKind = (typeof LIABILITY_KINDS)[number];
export const LIABILITY_BALANCE_SOURCES = ['manual', 'connector', 'schedule', 'import'] as const;
export type LiabilityBalanceSource = (typeof LIABILITY_BALANCE_SOURCES)[number];
export const GOAL_KINDS = ['generic', 'emergency_fund'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** Something the household owns. An asset linked to an account is valued through that account. */
export const asset = pgTable(
  'asset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AssetKind>().notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
    accountId: uuid('account_id'),
    currency: char('currency', { length: 3 }).notNull(),
    /** Yearly depreciation in basis points (vehicles); null means no depreciation. */
    depreciationBpsPerYear: integer('depreciation_bps_per_year'),
    /** Free-form facts about the asset (rooms, mileage, ...) that the AI valuation reads. */
    details: jsonb('details').$type<Record<string, unknown>>(),
    /** AI values this asset on a schedule; mutually exclusive with depreciation. */
    aiValuation: boolean('ai_valuation').notNull().default(false),
    aiRequestedAt: timestamp('ai_requested_at', { withTimezone: true }),
    aiAttemptedAt: timestamp('ai_attempted_at', { withTimezone: true }),
    aiLastError: text('ai_last_error'),
    /** Set together with `disposalKind` when the asset was sold or written off. */
    disposedOn: date('disposed_on', { mode: 'string' }),
    disposalKind: text('disposal_kind').$type<DisposalKind>(),
    /** Sale proceeds in the asset's currency, minor units; only for a sold asset. */
    saleAmount: bigint('sale_amount', { mode: 'number' }),
    /** The incoming transaction that recorded the sale; only for a sold asset. */
    saleTransactionId: uuid('sale_transaction_id'),
    archived: boolean('archived').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // SET NULL (account_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'asset_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    // SET NULL (sale_transaction_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'asset_sale_transaction_fk',
      columns: [t.saleTransactionId, t.householdId],
      foreignColumns: [transaction.id, transaction.householdId],
    }).onDelete('set null'),
    unique('asset_id_household_unique').on(t.id, t.householdId),
    check(
      'asset_kind_check',
      sql`${t.kind} in ('real_estate','vehicle','investment','cash','other')`,
    ),
    check(
      'asset_depreciation_check',
      sql`${t.depreciationBpsPerYear} is null or ${t.depreciationBpsPerYear} between 0 and 10000`,
    ),
    check(
      'asset_ai_depreciation_check',
      sql`not (${t.aiValuation} and ${t.depreciationBpsPerYear} is not null)`,
    ),
    check('asset_disposal_check', sql`(${t.disposedOn} is null) = (${t.disposalKind} is null)`),
    check('asset_disposal_kind_check', sql`${t.disposalKind} in ('sold','written_off')`),
    check(
      'asset_sale_check',
      sql`coalesce(${t.disposalKind}, '') = 'sold' or (${t.saleAmount} is null and ${t.saleTransactionId} is null)`,
    ),
    check('asset_sale_amount_check', sql`${t.saleAmount} is null or ${t.saleAmount} >= 0`),
    uniqueIndex('asset_sale_transaction_unique')
      .on(t.saleTransactionId)
      .where(sql`${t.saleTransactionId} is not null`),
    index('asset_household_idx').on(t.householdId),
  ],
);

/** Point-in-time value of an asset; the latest row on or before a date is its value then. */
export const assetValuation = pgTable(
  'asset_valuation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    value: bigint('value', { mode: 'number' }).notNull(),
    method: text('method').$type<ValuationMethod>().notNull(),
    note: text('note'),
    estimate: jsonb('estimate').$type<ValuationEstimate>(),
  },
  (t) => [
    foreignKey({
      name: 'asset_valuation_asset_fk',
      columns: [t.assetId, t.householdId],
      foreignColumns: [asset.id, asset.householdId],
    }).onDelete('cascade'),
    unique('asset_valuation_asset_as_of_unique').on(t.assetId, t.asOf),
    check('asset_valuation_value_check', sql`${t.value} >= 0`),
    check(
      'asset_valuation_method_check',
      sql`${t.method} in ('manual','connector','depreciation','import','ai')`,
    ),
    // Serves "latest valuation on or before a date" lookups.
    index('asset_valuation_household_asset_as_of_idx').on(
      t.householdId,
      t.assetId,
      sql`${t.asOf} desc`,
    ),
  ],
);

/** Something the household owes. Linked to a loan account and/or the asset it financed. */
export const liability = pgTable(
  'liability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<LiabilityKind>().notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
    accountId: uuid('account_id'),
    /** The financed asset (the house for a mortgage). */
    assetId: uuid('asset_id'),
    currency: char('currency', { length: 3 }).notNull(),
    /** Original amount borrowed, minor units. */
    principal: bigint('principal', { mode: 'number' }),
    annualRateBps: integer('annual_rate_bps'),
    termMonths: integer('term_months'),
    startDate: date('start_date', { mode: 'string' }),
    /** The date the liability was settled in full; null while it is still open. */
    settledOn: date('settled_on', { mode: 'string' }),
    archived: boolean('archived').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // SET NULL (x_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'liability_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    foreignKey({
      name: 'liability_asset_fk',
      columns: [t.assetId, t.householdId],
      foreignColumns: [asset.id, asset.householdId],
    }).onDelete('set null'),
    unique('liability_id_household_unique').on(t.id, t.householdId),
    check('liability_kind_check', sql`${t.kind} in ('mortgage','loan','debt','card','other')`),
    check(
      'liability_annual_rate_check',
      sql`${t.annualRateBps} is null or ${t.annualRateBps} between 0 and 100000`,
    ),
    check('liability_principal_check', sql`${t.principal} is null or ${t.principal} >= 0`),
    check(
      'liability_term_months_check',
      sql`${t.termMonths} is null or ${t.termMonths} between 1 and 600`,
    ),
    index('liability_household_idx').on(t.householdId),
  ],
);

/** Outstanding amount owed (never negative) at a date; latest on or before a date wins. */
export const liabilityBalance = pgTable(
  'liability_balance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    liabilityId: uuid('liability_id').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    balance: bigint('balance', { mode: 'number' }).notNull(),
    source: text('source').$type<LiabilityBalanceSource>().notNull(),
    note: text('note'),
  },
  (t) => [
    foreignKey({
      name: 'liability_balance_liability_fk',
      columns: [t.liabilityId, t.householdId],
      foreignColumns: [liability.id, liability.householdId],
    }).onDelete('cascade'),
    unique('liability_balance_liability_as_of_unique').on(t.liabilityId, t.asOf),
    check('liability_balance_balance_check', sql`${t.balance} >= 0`),
    check(
      'liability_balance_source_check',
      sql`${t.source} in ('manual','connector','schedule','import')`,
    ),
    // Serves "latest balance on or before a date" lookups.
    index('liability_balance_household_liability_as_of_idx').on(
      t.householdId,
      t.liabilityId,
      sql`${t.asOf} desc`,
    ),
  ],
);

/** What `net_worth_snapshot.breakdown` holds (household-currency totals only, no FX). */
export type NetWorthBreakdown = {
  /** Totals keyed `${side}:${kind}`, e.g. `asset:cash`, `liability:mortgage`. */
  byKind: Record<string, number>;
  /** Number of items left out of the totals because they are in another currency. */
  foreignCount: number;
};

/** Frozen month-end net worth (`month` = first day). Recomputing a past month replaces the row. */
export const netWorthSnapshot = pgTable(
  'net_worth_snapshot',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    month: date('month', { mode: 'string' }).notNull(),
    assets: bigint('assets', { mode: 'number' }).notNull(),
    liabilities: bigint('liabilities', { mode: 'number' }).notNull(),
    /** assets - liabilities; may be negative. */
    net: bigint('net', { mode: 'number' }).notNull(),
    breakdown: jsonb('breakdown').$type<NetWorthBreakdown>().notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'net_worth_snapshot_pk', columns: [t.householdId, t.month] }),
    check('net_worth_snapshot_month_check', sql`extract(day from ${t.month}) = 1`),
  ],
);

export const goal = pgTable(
  'goal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<GoalKind>().notNull(),
    name: text('name').notNull(),
    targetAmount: bigint('target_amount', { mode: 'number' }),
    targetDate: date('target_date', { mode: 'string' }),
    accountId: uuid('account_id'),
    budgetLineId: uuid('budget_line_id'),
    /** Explicit monthly contribution overriding the one derived from the budget line. */
    monthlyContribution: bigint('monthly_contribution', { mode: 'number' }),
    /**
     * Already saved on `saved_baseline_date` ("Já poupado", or the sheet's Saldo atual). Saved is
     * this plus the linked budget line's actuals after that date; an account-linked goal ignores it.
     */
    savedBaseline: bigint('saved_baseline', { mode: 'number' }),
    savedBaselineDate: date('saved_baseline_date', { mode: 'string' }),
    archived: boolean('archived').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // SET NULL (x_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'goal_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    foreignKey({
      name: 'goal_budget_line_fk',
      columns: [t.budgetLineId, t.householdId],
      foreignColumns: [budgetLine.id, budgetLine.householdId],
    }).onDelete('set null'),
    check('goal_kind_check', sql`${t.kind} in ('generic','emergency_fund')`),
    check('goal_target_amount_check', sql`${t.targetAmount} is null or ${t.targetAmount} >= 0`),
    check(
      'goal_monthly_contribution_check',
      sql`${t.monthlyContribution} is null or ${t.monthlyContribution} >= 0`,
    ),
    check('goal_saved_baseline_check', sql`${t.savedBaseline} is null or ${t.savedBaseline} >= 0`),
    check(
      'goal_saved_baseline_date_check',
      sql`(${t.savedBaseline} is null) = (${t.savedBaselineDate} is null)`,
    ),
    index('goal_household_idx').on(t.householdId),
    // One live emergency fund per household; archiving it frees the slot.
    uniqueIndex('goal_emergency_fund_unique')
      .on(t.householdId)
      .where(sql`${t.kind} = 'emergency_fund' and not ${t.archived}`),
  ],
);
