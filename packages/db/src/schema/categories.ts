import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { organization } from './auth.js';

// RLS (policy + grants) and the updated_at trigger live in the custom SQL migration, not here.
// Cross-household references are impossible: children use composite FKs (x_id, household_id)
// onto a unique (id, household_id). Nullable references use MATCH SIMPLE (null skips the check).
// Deleting a referenced category/merchant is blocked (no action), services re-home rows first.

export const MERCHANT_NAME_SOURCES = ['ai', 'user'] as const;
export type MerchantNameSource = (typeof MERCHANT_NAME_SOURCES)[number];

export const CATEGORY_GROUP_KINDS = ['income', 'expense', 'saving', 'transfer'] as const;
export type CategoryGroupKind = (typeof CATEGORY_GROUP_KINDS)[number];

/** Shape of `rule.condition`; every present field must match. `descriptionPattern` is a wildcard, not a regex. */
export interface RuleCondition {
  descriptionContains?: string;
  descriptionPattern?: string;
  counterpartyContains?: string;
  amountMin?: number;
  amountMax?: number;
  direction?: 'in' | 'out';
  accountIds?: string[];
}

export const categoryGroup = pgTable(
  'category_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<CategoryGroupKind>().notNull(),
    sort: smallint('sort').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    templateKey: text('template_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('category_group_id_household_unique').on(t.id, t.householdId),
    check('category_group_kind_check', sql`${t.kind} in ('income','expense','saving','transfer')`),
    index('category_group_household_idx').on(t.householdId),
  ],
);

export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull(),
    name: text('name').notNull(),
    icon: text('icon'),
    sort: smallint('sort').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    templateKey: text('template_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('category_id_household_unique').on(t.id, t.householdId),
    foreignKey({
      name: 'category_group_fk',
      columns: [t.groupId, t.householdId],
      foreignColumns: [categoryGroup.id, categoryGroup.householdId],
    }).onDelete('cascade'),
  ],
);

export const merchant = pgTable(
  'merchant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Normalised description key, unique per household. */
    key: text('key').notNull(),
    displayName: text('display_name').notNull(),
    defaultCategoryId: uuid('default_category_id'),
    /** Official website hostname (lower case), from the AI merchant pass. */
    domain: text('domain'),
    /** When the AI merchant pass last looked at this merchant. */
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    /** Who set `display_name`: the AI pass never overwrites a name set by the user. */
    nameSource: text('name_source').$type<MerchantNameSource>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('merchant_id_household_unique').on(t.id, t.householdId),
    unique('merchant_household_key_unique').on(t.householdId, t.key),
    check('merchant_name_source_check', sql`${t.nameSource} in ('ai','user')`),
    foreignKey({
      name: 'merchant_default_category_fk',
      columns: [t.defaultCategoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }),
  ],
);

export const MERCHANT_LOGO_STATUSES = ['ok', 'missing'] as const;
export type MerchantLogoStatus = (typeof MERCHANT_LOGO_STATUSES)[number];

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** The favicon fetched for a merchant's domain; `missing` records a failed or useless fetch. */
export const merchantLogo = pgTable(
  'merchant_logo',
  {
    merchantId: uuid('merchant_id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    contentType: text('content_type'),
    bytes: bytea('bytes'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').$type<MerchantLogoStatus>().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'merchant_logo_merchant_fk',
      columns: [t.merchantId, t.householdId],
      foreignColumns: [merchant.id, merchant.householdId],
    }).onDelete('cascade'),
    check('merchant_logo_status_check', sql`${t.status} in ('ok','missing')`),
    index('merchant_logo_household_idx').on(t.householdId),
  ],
);

export const rule = pgTable(
  'rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    priority: integer('priority').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    condition: jsonb('condition').$type<RuleCondition>().notNull(),
    categoryId: uuid('category_id').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'rule_category_fk',
      columns: [t.categoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }),
  ],
);
