import { sql } from 'drizzle-orm';
import { check, customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization, user } from './auth.js';

// RLS (policy), the pat_lookup() function, the member DELETE trigger and the append-only grants of
// audit_log live in the custom SQL migrations and ensureAppRole, not here.

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/**
 * Append-only record of what the MCP server (and the web UI, for PAT and consent changes) did in a
 * household. `credential` is `pat:<id>` or `oauth:<clientId>` for MCP calls. The app role can
 * only insert and select (see ensureAppRole), so rows cannot be edited or removed from the app.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** The acting user; kept (as null) when the account is deleted. */
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    credential: text('credential'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_household_created_idx').on(t.householdId, sql`${t.createdAt} desc`),
    check('audit_log_actor_check', sql`${t.actor} in ('mcp', 'web')`),
  ],
);

/**
 * A personal access token for the MCP endpoint. Only sha256(token) is stored; `prefix` (the first
 * 12 characters of the token) is for display. `member` has no (organization, user) key to
 * reference, so removing a membership drops the user's PATs of that household through the member
 * DELETE trigger (migration 0030), the same way push devices go (0028).
 */
export const personalAccessToken = pgTable(
  'personal_access_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: bytea('token_hash').notNull().unique('personal_access_token_token_hash_unique'),
    prefix: text('prefix').notNull(),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('personal_access_token_household_user_idx').on(t.householdId, t.userId),
    check('personal_access_token_name_check', sql`char_length(${t.name}) between 1 and 60`),
    check('personal_access_token_scope_check', sql`${t.scope} in ('read', 'read_write')`),
  ],
);
