import { and, eq, inArray } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import type { NotificationRow, ServiceCtx } from '@arfolio/services';
import { getDb } from '../lib/db';

interface Base {
  id: string;
  read: boolean;
  createdAt: string;
}

export interface ConnectionNotificationDto extends Base {
  kind: 'consent_expiring' | 'consent_expired' | 'sync_failing';
  connectionId: string | null;
  /** The connection it is about, when it still exists (null once removed). */
  connection: { id: string; provider: 'enablebanking' | 'trading212' } | null;
  name: string | null;
  /** consent end (ISO) for the consent kinds. */
  expiresAt: string | null;
  failures: number | null;
  errorCode: string | null;
}

export interface BudgetThresholdNotificationDto extends Base {
  kind: 'budget_line_threshold';
  /** Null when the line (or its budget) no longer exists: the copy turns generic. */
  lineId: string | null;
  lineName: string | null;
  budgetId: string | null;
  /** First day of the budget's first month, to turn `monthIndex` into a month. */
  budgetStart: string | null;
  monthIndex: number;
  threshold: number;
  planned: number;
  actual: number;
}

export interface UnallocatedNotificationDto extends Base {
  kind: 'budget_unallocated_negative';
  budgetId: string | null;
  budgetStart: string | null;
  monthIndex: number;
  remainingInHub: number;
}

export interface RecurringMissedNotificationDto extends Base {
  kind: 'recurring_missed';
  /** Null when the item no longer exists. */
  recurringId: string | null;
  name: string | null;
  expectedOn: string | null;
  amount: number;
  currency: string | null;
}

export interface RecurringPriceNotificationDto extends Base {
  kind: 'recurring_price_change';
  recurringId: string | null;
  name: string | null;
  previousAmount: number;
  amount: number;
  currency: string | null;
  date: string | null;
}

export interface AiReportNotificationDto extends Base {
  kind: 'ai_report_ready';
  /** The reported month (`yyyy-mm`); null when the payload is malformed. */
  month: string | null;
}

/** Client-safe notification, one shape per kind. The payload is jsonb: read it defensively. */
export type NotificationDto =
  | ConnectionNotificationDto
  | BudgetThresholdNotificationDto
  | UnallocatedNotificationDto
  | RecurringMissedNotificationDto
  | RecurringPriceNotificationDto
  | AiReportNotificationDto;

/** What the notifications refer to, as it is now: renamed or deleted targets resolve here. */
export interface NotificationLookups {
  connections: ReadonlyMap<string, 'enablebanking' | 'trading212'>;
  budgets: ReadonlyMap<string, { startMonth: string }>;
  lines: ReadonlyMap<string, { name: string; budgetId: string }>;
  recurring: ReadonlyMap<string, { name: string }>;
}

const EMPTY: NotificationLookups = {
  connections: new Map(),
  budgets: new Map(),
  lines: new Map(),
  recurring: new Map(),
};

const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, max) : null;

const isoOrNull = (value: unknown): string | null => {
  const v = text(value, 40);
  return v !== null && !Number.isNaN(Date.parse(v)) ? v : null;
};

const int = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;

const monthIndex = (value: unknown): number => Math.min(12, Math.max(1, int(value, 1)));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string | null => {
  const v = text(value, 64);
  return v !== null && UUID.test(v) ? v : null;
};

export function toNotificationDto(
  row: NotificationRow,
  lookups: Partial<NotificationLookups> = EMPTY,
): NotificationDto {
  const known = { ...EMPTY, ...lookups };
  const p = row.payload;
  const base: Base = { id: row.id, read: row.read, createdAt: row.createdAt.toISOString() };

  switch (row.kind) {
    case 'budget_line_threshold': {
      const lineId = id(p.lineId);
      const line = lineId ? known.lines.get(lineId) : undefined;
      const budgetId = id(p.budgetId);
      const budget = budgetId ? known.budgets.get(budgetId) : undefined;
      return {
        ...base,
        kind: row.kind,
        lineId: line ? lineId : null,
        lineName: line?.name ?? null,
        budgetId: budget ? budgetId : null,
        budgetStart: budget?.startMonth ?? null,
        monthIndex: monthIndex(p.monthIndex),
        threshold: int(p.threshold),
        planned: int(p.planned),
        actual: int(p.actual),
      };
    }
    case 'ai_report_ready': {
      const month = text(p.month, 7);
      return {
        ...base,
        kind: row.kind,
        month: month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null,
      };
    }
    case 'budget_unallocated_negative': {
      const budgetId = id(p.budgetId);
      const budget = budgetId ? known.budgets.get(budgetId) : undefined;
      return {
        ...base,
        kind: row.kind,
        budgetId: budget ? budgetId : null,
        budgetStart: budget?.startMonth ?? null,
        monthIndex: monthIndex(p.monthIndex),
        remainingInHub: int(p.remainingInHub),
      };
    }
    case 'recurring_missed':
    case 'recurring_price_change': {
      const recurringId = id(p.recurringId);
      const current = recurringId ? known.recurring.get(recurringId) : undefined;
      // The item's name as it is now; a deleted item has none and gets the generic copy.
      const name = current?.name ?? null;
      if (row.kind === 'recurring_missed') {
        return {
          ...base,
          kind: row.kind,
          recurringId: current ? recurringId : null,
          name,
          expectedOn: text(p.expectedOn, 10),
          amount: int(p.amount),
          currency: text(p.currency, 3),
        };
      }
      return {
        ...base,
        kind: row.kind,
        recurringId: current ? recurringId : null,
        name,
        previousAmount: int(p.previousAmount),
        amount: int(p.amount),
        currency: text(p.currency, 3),
        date: text(p.date, 10),
      };
    }
    default: {
      const connectionId = text(p.connectionId, 64);
      const provider = connectionId ? known.connections.get(connectionId) : undefined;
      const failures = typeof p.consecutiveFailures === 'number' ? p.consecutiveFailures : null;
      return {
        ...base,
        kind: row.kind,
        connectionId,
        connection: connectionId && provider ? { id: connectionId, provider } : null,
        name: text(p.displayName),
        expiresAt: isoOrNull(p.expiresAt),
        failures: failures !== null && Number.isFinite(failures) ? Math.trunc(failures) : null,
        errorCode: text(p.errorCode, 40),
      };
    }
  }
}

/**
 * Looks up the budgets, lines and recurring items the given notifications point at, so each can
 * be named as it is called now (or described generically when it is gone).
 */
export async function loadNotificationTargets(
  ctx: ServiceCtx,
  rows: readonly NotificationRow[],
): Promise<Pick<NotificationLookups, 'budgets' | 'lines' | 'recurring'>> {
  const ids = (key: string, kinds: readonly string[]): string[] => [
    ...new Set(
      rows
        .filter((r) => kinds.includes(r.kind))
        .map((r) => id(r.payload[key]))
        .filter((v): v is string => v !== null),
    ),
  ];
  const budgetIds = ids('budgetId', ['budget_line_threshold', 'budget_unallocated_negative']);
  const lineIds = ids('lineId', ['budget_line_threshold']);
  const recurringIds = ids('recurringId', ['recurring_missed', 'recurring_price_change']);
  if (budgetIds.length + lineIds.length + recurringIds.length === 0) {
    return { budgets: new Map(), lines: new Map(), recurring: new Map() };
  }
  return withHousehold(getDb(), ctx.householdId, async (tx) => {
    const [budgets, lines, recurring] = await Promise.all([
      budgetIds.length
        ? tx
            .select({ id: schema.budget.id, startMonth: schema.budget.startMonth })
            .from(schema.budget)
            .where(
              and(
                eq(schema.budget.householdId, ctx.householdId),
                inArray(schema.budget.id, budgetIds),
              ),
            )
        : [],
      lineIds.length
        ? tx
            .select({
              id: schema.budgetLine.id,
              name: schema.budgetLine.name,
              budgetId: schema.budgetLine.budgetId,
            })
            .from(schema.budgetLine)
            .where(
              and(
                eq(schema.budgetLine.householdId, ctx.householdId),
                inArray(schema.budgetLine.id, lineIds),
              ),
            )
        : [],
      recurringIds.length
        ? tx
            .select({ id: schema.recurring.id, name: schema.recurring.name })
            .from(schema.recurring)
            .where(
              and(
                eq(schema.recurring.householdId, ctx.householdId),
                inArray(schema.recurring.id, recurringIds),
              ),
            )
        : [],
    ]);
    return {
      budgets: new Map(budgets.map((b) => [b.id, { startMonth: b.startMonth }])),
      lines: new Map(lines.map((l) => [l.id, { name: l.name, budgetId: l.budgetId }])),
      recurring: new Map(recurring.map((r) => [r.id, { name: r.name }])),
    };
  });
}
