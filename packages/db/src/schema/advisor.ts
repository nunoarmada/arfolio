import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization, user } from './auth.js';

// RLS (policy `household_isolation`) lives in the SQL migration, not here. Every table is private
// to one member of one household: services filter by household_id AND user_id.

export const ADVISOR_PROPOSAL_KINDS = [
  'goal_create',
  'goal_update',
  'budget_line_amount',
  'rule_create',
  'transaction_categorise',
] as const;
export type AdvisorProposalKind = (typeof ADVISOR_PROPOSAL_KINDS)[number];

/** One chat or proactive message of the advisor conversation of a member. */
export const advisorMessage = pgTable(
  'advisor_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    origin: text('origin').notNull(),
    text: text('text').notNull(),
    /** Dedupes proactive messages: at most one per (member, event). Null for chat. */
    eventKey: text('event_key'),
    countsTowardCap: boolean('counts_toward_cap').notNull().default(false),
    status: text('status').notNull().default('complete'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('advisor_message_role_check', sql`${t.role} in ('user','assistant')`),
    check('advisor_message_origin_check', sql`${t.origin} in ('chat','proactive')`),
    check('advisor_message_status_check', sql`${t.status} in ('pending','complete','failed')`),
    index('advisor_message_member_created_idx').on(t.householdId, t.userId, t.createdAt.desc()),
    uniqueIndex('advisor_message_event_key_unique')
      .on(t.householdId, t.userId, t.eventKey)
      .where(sql`${t.eventKey} is not null`),
  ],
);

/** A change the advisor suggests; nothing is written to the household until the member applies it. */
export const advisorProposal = pgTable(
  'advisor_proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => advisorMessage.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    basis: jsonb('basis'),
    /** `updated_at` of the target row when proposed; a later change makes the proposal stale. */
    targetUpdatedAt: timestamp('target_updated_at', { withTimezone: true }),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'advisor_proposal_kind_check',
      sql`${t.kind} in ('goal_create','goal_update','budget_line_amount','rule_create','transaction_categorise')`,
    ),
    check(
      'advisor_proposal_status_check',
      sql`${t.status} in ('pending','applied','dismissed','stale')`,
    ),
    index('advisor_proposal_message_idx').on(t.messageId),
  ],
);

/** A short fact the member asked the advisor to remember. At most 30 per member (service). */
export const advisorNote = pgTable(
  'advisor_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('advisor_note_text_check', sql`char_length(${t.text}) <= 500`),
    index('advisor_note_member_idx').on(t.householdId, t.userId),
  ],
);

export const advisorMemberSettings = pgTable(
  'advisor_member_settings',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    proactiveEnabled: boolean('proactive_enabled').notNull().default(true),
    /** Proactive messages per week; null means the instance default. */
    weeklyCap: integer('weekly_cap'),
    /** First time the member opened the advisor; proactive messages never start before it. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.userId], name: 'advisor_member_settings_pk' }),
    check('advisor_member_settings_weekly_cap_check', sql`${t.weeklyCap} between 0 and 14`),
  ],
);
