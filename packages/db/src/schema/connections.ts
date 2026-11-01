import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { financialAccount } from './accounts.js';
import { organization } from './auth.js';

// RLS (policy + grants) and the updated_at triggers live in the custom SQL migration, not here.
// Children use composite FKs (x_id, household_id) onto a unique (id, household_id), so a row can
// never point at another household's connection or account.
// Secrets (`credentials_enc`, `external_session_id_enc`, `external_accounts_enc`) hold `encryptSecret` tokens only.

export const CONNECTION_PROVIDERS = ['enablebanking', 'trading212'] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export const CONNECTION_STATUSES = ['pending', 'active', 'expired', 'error', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export const SYNC_TRIGGERS = ['scheduled', 'manual', 'initial'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];
export const SYNC_RUN_STATUSES = ['running', 'success', 'partial', 'failed', 'skipped'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const connection = pgTable(
  'connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ConnectionProvider>().notNull(),
    displayName: text('display_name').notNull(),
    institutionName: text('institution_name'),
    institutionCountry: text('institution_country'),
    status: text('status').$type<ConnectionStatus>().notNull(),
    credentialsEnc: text('credentials_enc'),
    externalSessionIdEnc: text('external_session_id_enc'),
    /** `encryptSecret` token of the accounts `POST /sessions` returned: spares a provider call on the link step. */
    externalAccountsEnc: text('external_accounts_enc'),
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    /** Sanitised: never contains credentials or provider payloads. */
    lastErrorMessage: text('last_error_message'),
    manualRefreshesToday: integer('manual_refreshes_today').notNull().default(0),
    manualRefreshDay: date('manual_refresh_day', { mode: 'string' }),
    /**
     * Trading 212 only: rows booked on or before this day have had their merchant looked up in the
     * history CSV export (whether or not it knew them), so they are not requested again.
     */
    t212EnrichedThrough: date('t212_enriched_through', { mode: 'string' }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('connection_id_household_unique').on(t.id, t.householdId),
    check('connection_provider_check', sql`${t.provider} in ('enablebanking','trading212')`),
    check(
      'connection_status_check',
      sql`${t.status} in ('pending','active','expired','error','revoked')`,
    ),
    index('connection_household_idx').on(t.householdId),
    index('connection_next_sync_idx')
      .on(t.nextSyncAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const connectionAccount = pgTable(
  'connection_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull(),
    accountId: uuid('account_id').notNull(),
    /** Provider account uid; session-scoped for Enable Banking, so it changes on reconnect. */
    externalUid: text('external_uid').notNull(),
    /** Stable across reconnects: IBAN hash, `identification_hash` or the Trading 212 account id. */
    externalKey: text('external_key').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'connection_account_connection_fk',
      columns: [t.connectionId, t.householdId],
      foreignColumns: [connection.id, connection.householdId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'connection_account_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    unique('connection_account_connection_external_key_unique').on(t.connectionId, t.externalKey),
    // An account belongs to at most one connection.
    unique('connection_account_household_account_unique').on(t.householdId, t.accountId),
  ],
);

/** One-shot OAuth-style state for the bank consent redirect; only the sha256 hex is stored. */
export const consentState = pgTable(
  'consent_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull().unique('consent_state_state_hash_unique'),
    /** Set when reconnecting an existing connection. */
    connectionId: uuid('connection_id'),
    userId: text('user_id').notNull(),
    aspspName: text('aspsp_name').notNull(),
    aspspCountry: text('aspsp_country').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'consent_state_connection_fk',
      columns: [t.connectionId, t.householdId],
      foreignColumns: [connection.id, connection.householdId],
    }).onDelete('cascade'),
    index('consent_state_expires_idx').on(t.expiresAt),
  ],
);

export const syncRun = pgTable(
  'sync_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull(),
    trigger: text('trigger').$type<SyncTrigger>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').$type<SyncRunStatus>().notNull(),
    inserted: integer('inserted').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    pendingReplaced: integer('pending_replaced').notNull().default(0),
    providerCalls: integer('provider_calls').notNull().default(0),
    /** Provider rows that could not be mapped and were left out (never their content). */
    skippedRows: integer('skipped_rows').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [
    foreignKey({
      name: 'sync_run_connection_fk',
      columns: [t.connectionId, t.householdId],
      foreignColumns: [connection.id, connection.householdId],
    }).onDelete('cascade'),
    check('sync_run_trigger_check', sql`${t.trigger} in ('scheduled','manual','initial')`),
    check(
      'sync_run_status_check',
      sql`${t.status} in ('running','success','partial','failed','skipped')`,
    ),
    index('sync_run_connection_started_idx').on(t.connectionId, t.startedAt.desc()),
  ],
);

export const balanceSnapshot = pgTable(
  'balance_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    /** Signed bigint minor units. */
    balance: bigint('balance', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'balance_snapshot_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    unique('balance_snapshot_account_as_of_source_unique').on(t.accountId, t.asOf, t.source),
  ],
);

export const positionSnapshot = pgTable(
  'position_snapshot',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    /** Ticker or ISIN. */
    instrument: text('instrument').notNull(),
    name: text('name'),
    /** Exact decimal as a string (never a float). */
    quantity: numeric('quantity', { precision: 28, scale: 10 }).notNull(),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    valueMinor: bigint('value_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Account-currency minor units; null on snapshots taken before these were stored. */
    costMinor: bigint('cost_minor', { mode: 'number' }),
    unrealizedPlMinor: bigint('unrealized_pl_minor', { mode: 'number' }),
    ticker: text('ticker'),
    isin: text('isin'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'position_snapshot_account_fk',
      columns: [t.accountId, t.householdId],
      foreignColumns: [financialAccount.id, financialAccount.householdId],
    }).onDelete('cascade'),
    unique('position_snapshot_account_as_of_instrument_unique').on(
      t.accountId,
      t.asOf,
      t.instrument,
    ),
  ],
);

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Null means every member of the household. */
    userId: text('user_id'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Makes a notification idempotent per household, e.g. consent expiring once per expiry. */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once the web-push sender has handled this notification (sent, or nobody to send to). */
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
  },
  (t) => [
    unique('notification_id_household_unique').on(t.id, t.householdId),
    uniqueIndex('notification_household_dedupe_key_unique')
      .on(t.householdId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('notification_household_created_idx').on(t.householdId, t.createdAt.desc()),
    // Serves "pushed_at is null and created_at > now() - 24h" (now() is not immutable, so the
    // window itself cannot be part of the predicate).
    index('notification_unpushed_idx')
      .on(t.createdAt)
      .where(sql`${t.pushedAt} is null`),
  ],
);

/**
 * Per-user read state: most notifications are household-wide (`user_id` null), so "read" cannot
 * live on the notification row. A row here means that user has read that notification.
 */
export const notificationRead = pgTable(
  'notification_read',
  {
    notificationId: uuid('notification_id').notNull(),
    userId: text('user_id').notNull(),
    householdId: text('household_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'notification_read_pk', columns: [t.notificationId, t.userId] }),
    foreignKey({
      name: 'notification_read_notification_fk',
      columns: [t.notificationId, t.householdId],
      foreignColumns: [notification.id, notification.householdId],
    }).onDelete('cascade'),
    index('notification_read_user_idx').on(t.householdId, t.userId),
  ],
);
