import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';

// RLS (policy + grants) and the updated_at trigger live in the custom SQL migration, not here.

export const IMPORT_SOURCES = ['csv', 'ofx', 'xlsx'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const importBatch = pgTable(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    source: text('source').$type<ImportSource>().notNull(),
    filename: text('filename').notNull(),
    presetKey: text('preset_key'),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsImported: integer('rows_imported').notNull().default(0),
    rowsDuplicate: integer('rows_duplicate').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    createdBy: text('created_by').notNull(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('import_batch_id_household_unique').on(t.id, t.householdId),
    foreignKey({
      name: 'import_batch_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    check('import_batch_source_check', sql`${t.source} in ('csv','ofx','xlsx')`),
  ],
);

export const IMPORT_PRESET_KINDS = ['csv', 'xlsx'] as const;
export type ImportPresetKind = (typeof IMPORT_PRESET_KINDS)[number];

export const importPreset = pgTable(
  'import_preset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<ImportPresetKind>().notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('import_preset_household_name_unique').on(t.householdId, t.name),
    check('import_preset_kind_check', sql`${t.kind} in ('csv','xlsx')`),
  ],
);
