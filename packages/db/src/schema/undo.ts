import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organization } from './auth.js';

// RLS (policy + grants) lives in the custom SQL migration, like the other household tables.

export const UNDO_KINDS = ['categorisation', 'budget_import', 'rule_application'] as const;
export type UndoKind = (typeof UNDO_KINDS)[number];

/**
 * A server-held way back from a user action. The client only ever gets the opaque `id`; what is
 * restored lives in `payload`, so a caller cannot make the server write state it chose.
 * Tokens belong to one user, work once and expire.
 */
export const undoToken = pgTable(
  'undo_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind').$type<UndoKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('undo_token_expires_idx').on(t.expiresAt)],
);
