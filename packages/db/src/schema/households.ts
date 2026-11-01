import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';

// RLS for this table (policy + grants) lives in the custom SQL migration, not here.
// `hub_account_id` FK is hand-edited to `ON DELETE SET NULL (hub_account_id)` (Postgres 15+) so
// deleting the account never nulls household_id.
export const householdSettings = pgTable(
  'household_settings',
  {
    householdId: text('household_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('UTC'),
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),
    emergencyFundMonths: smallint('emergency_fund_months').notNull().default(6),
    aiEnabled: boolean('ai_enabled').notNull().default(false),
    /** Household's main "hub" account for budget saving flows; null until chosen. */
    hubAccountId: uuid('hub_account_id'),
    /**
     * Budget usage percentages that raise an alert. An empty array is valid and means "no budget
     * alerts"; NULL elements and values outside 1..200 are rejected.
     */
    budgetAlertThresholds: smallint('budget_alert_thresholds')
      .array()
      .notNull()
      .default(sql`'{80,100}'::smallint[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'household_settings_hub_account_fk',
      columns: [t.hubAccountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('set null'),
    check(
      'household_settings_fiscal_year_start_month_check',
      sql`${t.fiscalYearStartMonth} between 1 and 12`,
    ),
    check(
      'household_settings_budget_alert_thresholds_check',
      sql`1 <= all(${t.budgetAlertThresholds}) and 200 >= all(${t.budgetAlertThresholds}) and array_position(${t.budgetAlertThresholds}, null) is null`,
    ),
  ],
);
