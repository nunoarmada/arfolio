import { z } from 'zod';
import type { Db, Tx } from '@arfolio/db';

export type Role = 'owner' | 'member' | 'viewer';

/** Who is acting, in which household. Every service takes one; `householdId` scopes all access. */
export type ServiceCtx = { db: Db; householdId: string; userId: string; role: Role };

/**
 * Optional hook of a write service: `onCommit` runs inside the service's own household transaction,
 * after the change and with its result, so a caller can add rows (the MCP audit entry) that commit
 * or roll back together with it. A throwing hook rolls the whole write back.
 */
export type WriteOpts<R> = { onCommit?: (tx: Tx, result: R) => Promise<void> };

export class NotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} not found`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'This role cannot modify data') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The request is valid but clashes with current state (e.g. a sync is running). */
export class ConflictError extends Error {
  constructor(
    readonly code:
      | 'sync_in_progress'
      | 'ai_categorisation_changed'
      | 'category_already_linked'
      | 'bucket_already_linked'
      | 'budget_exists'
      | 'set_by_environment',
    message: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The largest amount a budget or subscription accepts, in minor units (1e10 in major units). */
export const MAX_AMOUNT_MINOR = 1e12;

/** Stable reasons the UI explains in the user's language (the message is English, for logs). */
export type ValidationCode =
  | 'unknown_bank'
  | 'connection_revoked'
  | 'connection_inactive'
  | 'unknown_provider_account'
  | 'account_linked_elsewhere'
  | 'currency_mismatch'
  | 'different_account'
  | 'budget_exists'
  | 'emergency_fund_exists'
  | 'account_already_linked'
  | 'transfer_category'
  | 'buckets_need_investment_account'
  | 'line_name_taken'
  | 'invalid_timezone'
  | 'too_many_rows'
  | 'not_reopenable'
  | 'missing_sheet'
  | 'invalid_amount'
  | 'amount_too_large'
  | 'missing_section'
  | 'missing_columns'
  | 'no_visible_sheet'
  | 'negative_amount'
  | 'invalid_config'
  | 'name_too_long'
  | 'duplicate_month'
  | 'unreadable_file'
  | 'asset_disposed'
  | 'preview_used'
  | 'preview_expired'
  | 'regenerate_limit'
  | 'month_not_closed'
  | 'month_not_allowed'
  | 'ai_not_eligible'
  | 'ai_depreciation_conflict'
  | 'liability_already_settled'
  | 'liability_not_settled'
  | 'date_in_future'
  | 'card_cannot_link_asset'
  | 'asset_not_live'
  | 'asset_already_disposed'
  | 'asset_archived'
  | 'asset_not_disposed'
  | 'sale_needs_amount'
  | 'sale_transaction_invalid'
  | 'sale_transaction_taken'
  | 'liability_not_linked';

export class ValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
  /** Set only where a caller needs to tell this failure from other invalid input. */
  readonly code?: ValidationCode;
  /** Values the UI shows for `code` (e.g. the section and the limit of `too_many_rows`). */
  readonly params?: Readonly<Record<string, string | number>>;
  constructor(
    message: string,
    issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> = [],
    code?: ValidationCode,
    params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
    if (code !== undefined) this.code = code;
    if (params !== undefined) this.params = params;
  }
}

/** Viewers are read-only: every write service calls this first. */
export function assertCanWrite(ctx: ServiceCtx): void {
  if (ctx.role === 'viewer') throw new ForbiddenError();
}

/** Household-wide settings are the owner's: every settings write calls this first. */
export function assertOwner(ctx: ServiceCtx): void {
  if (ctx.role !== 'owner') throw new ForbiddenError('Only the household owner can change this');
}

/** Parses `input` with `schema`, converting zod failures into ValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path, message: i.message }));
    const detail = issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    throw new ValidationError(`Invalid input (${detail})`, issues);
  }
  return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id cannot exist, so it is "not found" rather than a database cast error. */
export function assertUuid(id: string, entity: string): void {
  if (typeof id !== 'string' || !UUID.test(id)) throw new NotFoundError(entity);
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** A real calendar day as YYYY-MM-DD (rejects 2026-02-30, which Postgres would fail on). */
export const calendarDate = isoDate.refine((d) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, day));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === day
  );
}, 'not a real calendar date');
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code');
