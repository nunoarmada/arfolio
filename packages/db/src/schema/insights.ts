import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth.js';

// RLS (the household_isolation policy) lives in the custom SQL migration 0034, not here.

export type AiReportStatus = 'pending' | 'ready' | 'failed' | 'skipped';

/**
 * The AI report of one household month: one row per (household, month), replaced on regenerate.
 * `facts` is the fact sheet the model was given (so the UI can show the real figures next to the
 * text), `content` the model output. A `pending` row is a request the worker sweep picks up (the
 * web has no queue connection); `attempts`/`next_attempt_at` drive its retry backoff. Token usage
 * sits on the row (no separate usage table).
 */
export const aiReport = pgTable(
  'ai_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** First day of the reported month (`yyyy-mm-01`). */
    month: date('month', { mode: 'string' }).notNull(),
    status: text('status').$type<AiReportStatus>().notNull(),
    model: text('model'),
    locale: text('locale').notNull(),
    facts: jsonb('facts').$type<unknown>(),
    content: jsonb('content').$type<unknown>(),
    errorCode: text('error_code'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    regenerations: integer('regenerations').notNull().default(0),
    /** Who asked for it (null for the scheduled report, or once the account is deleted). */
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ai_report_household_month_unique').on(t.householdId, t.month),
    index('ai_report_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
    check('ai_report_status_check', sql`${t.status} in ('pending','ready','failed','skipped')`),
    check('ai_report_month_check', sql`extract(day from ${t.month}) = 1`),
  ],
);
