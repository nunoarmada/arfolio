import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';
import { category, categoryGroup } from './categories.js';
import { investmentBucket } from './investments.js';

// RLS (policy + grants) and the updated_at triggers live in the custom SQL migration, not here.
// Children use composite FKs (x_id, household_id) onto a unique (id, household_id), so a row can
// never point at another household's data. Nullable references use MATCH SIMPLE (null skips the
// check). `ON DELETE SET NULL` on those composite FKs is hand-edited in the migration to the
// Postgres 15+ column-list form `SET NULL (x_id)`, otherwise it would also null household_id.

export const BUDGET_STATUSES = ['active', 'archived'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];
export const BUDGET_LINE_KINDS = ['income', 'expense', 'saving'] as const;
export type BudgetLineKind = (typeof BUDGET_LINE_KINDS)[number];
export const RECURRING_CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];
export const RECURRING_STATUSES = ['detected', 'confirmed', 'dismissed'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];
export const RECURRING_SOURCES = ['detected', 'declared', 'import'] as const;
export type RecurringSource = (typeof RECURRING_SOURCES)[number];

/** One budget year per household, identified by its start month (always the first day). */
export const budget = pgTable(
  'budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** First day of the first month of the 12-month budget year (`yyyy-mm-01`). */
    startMonth: date('start_month', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    status: text('status').$type<BudgetStatus>().notNull().default('active'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('budget_id_household_unique').on(t.id, t.householdId),
    unique('budget_household_start_month_unique').on(t.householdId, t.startMonth),
    check('budget_status_check', sql`${t.status} in ('active','archived')`),
    check('budget_start_month_check', sql`extract(day from ${t.startMonth}) = 1`),
  ],
);

export const budgetLine = pgTable(
  'budget_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    budgetId: uuid('budget_id').notNull(),
    kind: text('kind').$type<BudgetLineKind>().notNull(),
    name: text('name').notNull(),
    groupId: uuid('group_id'),
    accountId: uuid('account_id'),
    position: integer('position').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'budget_line_budget_fk',
      columns: [t.budgetId, t.householdId],
      foreignColumns: [budget.id, budget.householdId],
    }).onDelete('cascade'),
    // SET NULL (group_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'budget_line_group_fk',
      columns: [t.groupId, t.householdId],
      foreignColumns: [categoryGroup.id, categoryGroup.householdId],
    }).onDelete('set null'),
    foreignKey({
      name: 'budget_line_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    unique('budget_line_id_household_unique').on(t.id, t.householdId),
    // Supports the composite FK from budget_line_category that pins its denormalised budget_id.
    unique('budget_line_id_budget_household_unique').on(t.id, t.budgetId, t.householdId),
    unique('budget_line_budget_kind_name_unique').on(t.budgetId, t.kind, t.name),
    check('budget_line_kind_check', sql`${t.kind} in ('income','expense','saving')`),
    index('budget_line_household_budget_idx').on(t.householdId, t.budgetId),
  ],
);

/**
 * Links a budget line to the categories whose transactions count as its actuals. `budget_id` is
 * denormalised so a category can belong to at most one line per budget; the composite FK onto
 * (id, budget_id, household_id) guarantees it matches the line's own budget.
 */
export const budgetLineCategory = pgTable(
  'budget_line_category',
  {
    budgetLineId: uuid('budget_line_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    budgetId: uuid('budget_id').notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'budget_line_category_pk', columns: [t.budgetLineId, t.categoryId] }),
    foreignKey({
      name: 'budget_line_category_line_fk',
      columns: [t.budgetLineId, t.budgetId, t.householdId],
      foreignColumns: [budgetLine.id, budgetLine.budgetId, budgetLine.householdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'budget_line_category_category_fk',
      columns: [t.categoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }).onDelete('cascade'),
    unique('budget_line_category_budget_category_unique').on(t.budgetId, t.categoryId),
    index('budget_line_category_household_idx').on(t.householdId),
  ],
);

/**
 * Links a saving line to investment buckets (pies). `budget_id` is denormalised so a bucket can
 * belong to at most one line per budget; the composite FK onto (id, budget_id, household_id)
 * guarantees it matches the line's own budget.
 */
export const budgetLineBucket = pgTable(
  'budget_line_bucket',
  {
    budgetLineId: uuid('budget_line_id').notNull(),
    budgetId: uuid('budget_id').notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    bucketId: uuid('bucket_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'budget_line_bucket_pk', columns: [t.budgetLineId, t.bucketId] }),
    foreignKey({
      name: 'budget_line_bucket_line_fk',
      columns: [t.budgetLineId, t.budgetId, t.householdId],
      foreignColumns: [budgetLine.id, budgetLine.budgetId, budgetLine.householdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'budget_line_bucket_bucket_fk',
      columns: [t.bucketId, t.householdId],
      foreignColumns: [investmentBucket.id, investmentBucket.householdId],
    }).onDelete('cascade'),
    unique('budget_line_bucket_budget_bucket_unique').on(t.budgetId, t.bucketId),
    index('budget_line_bucket_household_idx').on(t.householdId),
  ],
);

/** Planned amount per line and month of the budget year (`month_index` 1 = start month). */
export const budgetAmount = pgTable(
  'budget_amount',
  {
    budgetLineId: uuid('budget_line_id').notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    monthIndex: smallint('month_index').notNull(),
    /** Positive minor units for all three kinds. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'budget_amount_pk', columns: [t.budgetLineId, t.monthIndex] }),
    foreignKey({
      name: 'budget_amount_line_fk',
      columns: [t.budgetLineId, t.householdId],
      foreignColumns: [budgetLine.id, budgetLine.householdId],
    }).onDelete('cascade'),
    check('budget_amount_month_index_check', sql`${t.monthIndex} between 1 and 12`),
    check('budget_amount_amount_check', sql`${t.amount} >= 0`),
    index('budget_amount_household_idx').on(t.householdId),
  ],
);

export const recurring = pgTable(
  'recurring',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id'),
    merchantKey: text('merchant_key').notNull(),
    name: text('name').notNull(),
    /** Typical amount, signed minor units (expense negative, income positive). */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    cadence: text('cadence').$type<RecurringCadence>().notNull(),
    nextExpectedOn: date('next_expected_on', { mode: 'string' }),
    lastSeenOn: date('last_seen_on', { mode: 'string' }),
    status: text('status').$type<RecurringStatus>().notNull(),
    source: text('source').$type<RecurringSource>().notNull(),
    categoryId: uuid('category_id'),
    budgetLineId: uuid('budget_line_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // SET NULL (x_id) is hand-edited into the migration, see the header comment.
    foreignKey({
      name: 'recurring_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    foreignKey({
      name: 'recurring_category_fk',
      columns: [t.categoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }).onDelete('set null'),
    foreignKey({
      name: 'recurring_budget_line_fk',
      columns: [t.budgetLineId, t.householdId],
      foreignColumns: [budgetLine.id, budgetLine.householdId],
    }).onDelete('set null'),
    // Only detector output is deduplicated; declared and imported rows may share a key.
    uniqueIndex('recurring_detected_merchant_cadence_unique')
      .on(t.householdId, t.merchantKey, t.cadence)
      .where(sql`${t.source} = 'detected'`),
    check(
      'recurring_cadence_check',
      sql`${t.cadence} in ('weekly','monthly','quarterly','yearly')`,
    ),
    check('recurring_status_check', sql`${t.status} in ('detected','confirmed','dismissed')`),
    check('recurring_source_check', sql`${t.source} in ('detected','declared','import')`),
    index('recurring_household_status_idx').on(t.householdId, t.status),
  ],
);
