import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Process-wide key/value status (worker heartbeat, last backup). Not tenant data: no RLS. */
export const systemStatus = pgTable('system_status', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
