import {
  bigint,
  char,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';

// RLS (policy) lives in the custom SQL appended to the migration, not here. Children use
// composite FKs (x_id, household_id) so a row can never point at another household's data.

/**
 * A named sub-portfolio of an investment account (a Trading 212 "pie"), synced daily. Buckets that
 * vanish from the provider are kept with `removed_at` set so existing budget links stay valid.
 */
export const investmentBucket = pgTable(
  'investment_bucket',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    /** Provider key, currently only `trading212`. */
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'investment_bucket_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    unique('investment_bucket_id_household_unique').on(t.id, t.householdId),
    unique('investment_bucket_account_external_unique').on(t.accountId, t.externalId),
    index('investment_bucket_household_idx').on(t.householdId),
  ],
);

/** Daily invested/market value of a bucket in account-currency minor units. */
export const investmentBucketSnapshot = pgTable(
  'investment_bucket_snapshot',
  {
    bucketId: uuid('bucket_id').notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    investedMinor: bigint('invested_minor', { mode: 'number' }).notNull(),
    valueMinor: bigint('value_minor', { mode: 'number' }),
    currency: char('currency', { length: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'investment_bucket_snapshot_pk', columns: [t.bucketId, t.asOf] }),
    foreignKey({
      name: 'investment_bucket_snapshot_bucket_fk',
      columns: [t.bucketId, t.householdId],
      foreignColumns: [investmentBucket.id, investmentBucket.householdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'investment_bucket_snapshot_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    index('investment_bucket_snapshot_account_as_of_idx').on(t.accountId, t.asOf),
  ],
);
