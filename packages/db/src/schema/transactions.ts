import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';
import { category, merchant } from './categories.js';
import { importBatch } from './imports.js';

// `amount` is signed bigint minor units (outflow negative), read as a JS number
// (`mode: 'number'`): safe because values stay far below 2^53.
// RLS (policy + grants) and the updated_at trigger live in the custom SQL migration, not here.
// The table is literally named "transaction" (an SQL keyword): always quote it in raw SQL.

export const TRANSACTION_STATUSES = ['pending', 'booked'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const CATEGORISED_BY = ['rule', 'memory', 'ai', 'user'] as const;
export type CategorisedBy = (typeof CATEGORISED_BY)[number];
export const TRANSACTION_SOURCES = ['connector', 'import', 'manual'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const transaction = pgTable(
  'transaction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    externalId: text('external_id'),
    dedupeHash: text('dedupe_hash').notNull(),
    bookingDate: date('booking_date', { mode: 'string' }).notNull(),
    valueDate: date('value_date', { mode: 'string' }),
    /** The day the purchase happened, when the provider says (distinct from booking/value date). */
    transactionDate: date('transaction_date', { mode: 'string' }),
    /**
     * The day the money was spent: the purchase date when the provider gives one, else the booking
     * date. Periods, budgets, analytics and the transaction list all count by this day, so a card
     * statement that books a month of purchases on one day still lands each one on its own day.
     * Balances stay on `booking_date` (when the money actually moved).
     */
    purchaseDate: date('purchase_date', { mode: 'string' })
      .generatedAlwaysAs(sql`coalesce(transaction_date, booking_date)`)
      .notNull(),
    /** Exact time of the operation, when the provider gives one. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status').$type<TransactionStatus>().notNull(),
    rawDescription: text('raw_description').notNull(),
    counterparty: text('counterparty'),
    /** ISO 18245 merchant category code (four digits). */
    mcc: text('mcc'),
    /** Provider extras, validated by `transactionDetailsSchema` in `@arfolio/core` before it is stored. */
    details: jsonb('details').$type<Record<string, unknown>>(),
    /** When the AI merchant pass looked at this row (also when it found no merchant). */
    merchantEnrichedAt: timestamp('merchant_enriched_at', { withTimezone: true }),
    /** Times the row was sent to the merchant pass; rows stop being sent at the cap. */
    merchantEnrichAttempts: smallint('merchant_enrich_attempts').notNull().default(0),
    merchantId: uuid('merchant_id'),
    categoryId: uuid('category_id'),
    categorisedBy: text('categorised_by').$type<CategorisedBy>(),
    confidence: real('confidence'),
    /**
     * Phase 2: a stored model suggestion. Categorisation now applies the model's answer straight
     * away, so only rows from before that change (and the undo of a user's choice) carry one.
     */
    aiSuggestedCategoryId: uuid('ai_suggested_category_id'),
    /** The model's confidence in the category it applied (0 when it gave up and used "Outros"). */
    aiConfidence: real('ai_confidence'),
    /** Times the row was sent to the model; at three without a category it falls back to "Outros". */
    aiAttempts: smallint('ai_attempts').notNull().default(0),
    needsReview: boolean('needs_review').notNull().default(false),
    transferGroupId: uuid('transfer_group_id'),
    notes: text('notes'),
    source: text('source').$type<TransactionSource>().notNull(),
    importBatchId: uuid('import_batch_id'),
    userEditedAt: timestamp('user_edited_at', { withTimezone: true }),
    /** Set when a user marks or unlinks a transfer: automatic pairing must leave the row alone. */
    transferLocked: boolean('transfer_locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'transaction_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'transaction_category_fk',
      columns: [t.categoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }),
    foreignKey({
      name: 'transaction_ai_suggested_category_fk',
      columns: [t.aiSuggestedCategoryId, t.householdId],
      foreignColumns: [category.id, category.householdId],
    }),
    foreignKey({
      name: 'transaction_merchant_fk',
      columns: [t.merchantId, t.householdId],
      foreignColumns: [merchant.id, merchant.householdId],
    }),
    foreignKey({
      name: 'transaction_import_batch_fk',
      columns: [t.importBatchId, t.householdId],
      foreignColumns: [importBatch.id, importBatch.householdId],
    }),
    unique('transaction_id_household_unique').on(t.id, t.householdId),
    uniqueIndex('transaction_account_external_id_unique')
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex('transaction_account_dedupe_hash_unique').on(t.accountId, t.dedupeHash),
    index('transaction_household_booking_date_idx').on(t.householdId, t.bookingDate.desc()),
    index('transaction_household_purchase_date_idx').on(t.householdId, t.purchaseDate.desc()),
    index('transaction_household_needs_review_idx')
      .on(t.householdId, t.needsReview)
      .where(sql`${t.needsReview}`),
    index('transaction_household_category_idx').on(t.householdId, t.categoryId),
    index('transaction_household_ai_suggested_category_idx').on(
      t.householdId,
      t.aiSuggestedCategoryId,
    ),
    index('transaction_household_import_batch_idx')
      .on(t.householdId, t.importBatchId)
      .where(sql`${t.importBatchId} is not null`),
    index('transaction_household_transfer_group_idx')
      .on(t.householdId, t.transferGroupId)
      .where(sql`${t.transferGroupId} is not null`),
    index('transaction_household_merchant_idx').on(t.householdId, t.merchantId),
    check('transaction_status_check', sql`${t.status} in ('pending','booked')`),
    check(
      'transaction_categorised_by_check',
      sql`${t.categorisedBy} is null or ${t.categorisedBy} in ('rule','memory','ai','user')`,
    ),
    check('transaction_source_check', sql`${t.source} in ('connector','import','manual')`),
  ],
);
