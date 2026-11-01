import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { organization } from './auth.js';

// Money columns (here and in transactions.ts) are bigint minor units read as JS numbers
// (`mode: 'number'`). Safe because values stay far below 2^53 (about 9e15 minor units).
//
// RLS (policy + grants) and the updated_at trigger live in the custom SQL migration, not here.
// Named financialAccount because Better Auth already owns the `account` table.

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'card',
  'investment',
  'meal_benefit',
  'cash',
  'loan',
  'other',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const financialAccount = pgTable(
  'financial_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<AccountType>().notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    institutionName: text('institution_name'),
    ibanLast4: text('iban_last4'),
    openingBalance: bigint('opening_balance', { mode: 'number' }).notNull().default(0),
    openingBalanceDate: date('opening_balance_date', { mode: 'string' }),
    includeInBudget: boolean('include_in_budget').notNull().default(true),
    includeInNetWorth: boolean('include_in_net_worth').notNull().default(true),
    /**
     * Credit limit of a `card`, minor units. When set, a connector balance on the card is read as
     * the available credit, so the amount owed is limit − balance.
     */
    creditLimit: bigint('credit_limit', { mode: 'number' }),
    /** Phase 2 bank connection; no FK yet. */
    connectionId: uuid('connection_id'),
    externalId: text('external_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    sort: smallint('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of composite FKs so children cannot reference another household's account.
    unique('financial_account_id_household_unique').on(t.id, t.householdId),
    check(
      'financial_account_type_check',
      sql`${t.type} in ('checking','savings','card','investment','meal_benefit','cash','loan','other')`,
    ),
    check(
      'financial_account_credit_limit_check',
      sql`${t.creditLimit} is null or (${t.creditLimit} >= 0 and ${t.type} = 'card')`,
    ),
  ],
);
