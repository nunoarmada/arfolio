import { and, desc, eq, inArray } from 'drizzle-orm';
import { budgetMonths } from '@arfolio/core';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { crossedThresholds } from './budget-alert-thresholds.js';
import { budgetMonthView, transferPlan } from './budgets.js';
import type { ServiceCtx } from './context.js';
import { createNotificationInTx } from './notifications.js';
import { localDay } from './sync.js';

const { budget, householdSettings, notification, organization } = schema;

/**
 * Acting identity of the job. It uses the owner role only to call the read views
 * (`budgetMonthView`, `transferPlan`); nothing here calls a write service.
 */
const SYSTEM_USER_ID = 'system:budget-alerts';

export type BudgetAlertsDeps = { db: Db; now?: Date };
export type BudgetAlertsResult = { lineAlerts: number; unallocatedAlerts: number };

/** Every household, for the daily job to queue one alert pass per household. */
export async function findBudgetAlertHouseholds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: organization.id }).from(organization);
  return rows.map((r) => r.id);
}

/**
 * Daily pass for one household. The current budget month is the one whose 12-month range contains
 * today (household timezone); with none there is nothing to do. Each expense line whose booked
 * actual reaches a threshold percentage of its planned amount gets one notification per
 * month for the highest threshold reached (a jump across several is one alert), and a negative hub remainder in the transfer plan gets one per month.
 * Numbers come from the same functions the budget screens use. Reruns are no-ops: dedupe keys.
 */
export async function runBudgetAlerts(
  deps: BudgetAlertsDeps,
  householdId: string,
): Promise<BudgetAlertsResult> {
  const now = deps.now ?? new Date();
  const result: BudgetAlertsResult = { lineAlerts: 0, unallocatedAlerts: 0 };

  const found = await withHousehold(deps.db, householdId, async (tx) => {
    const [settings] = await tx
      .select({
        timezone: householdSettings.timezone,
        thresholds: householdSettings.budgetAlertThresholds,
      })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    if (!settings) return null;
    const today = localDay(now, settings.timezone);
    const budgets = await tx
      .select({ id: budget.id, startMonth: budget.startMonth })
      .from(budget)
      .where(and(eq(budget.householdId, householdId), eq(budget.status, 'active')))
      .orderBy(desc(budget.startMonth));
    // Latest start wins when active budgets overlap, so the choice is deterministic.
    for (const b of budgets) {
      const month = budgetMonths(b.startMonth, settings.timezone).find(
        (m) => m.from <= today && today <= m.to,
      );
      if (month) return { budgetId: b.id, month, thresholds: settings.thresholds };
    }
    return null;
  });
  if (!found) return result;

  const { budgetId, month, thresholds } = found;
  const yyyymm = month.from.slice(0, 7);
  const ctx: ServiceCtx = { db: deps.db, householdId, userId: SYSTEM_USER_ID, role: 'owner' };
  const view = await budgetMonthView(ctx, budgetId, month.index);
  const plan = await transferPlan(ctx, budgetId, month.index);

  await withHousehold(deps.db, householdId, async (tx) => {
    for (const line of view.lines) {
      if (line.kind !== 'expense' || line.planned <= 0) continue;
      // A jump across several thresholds is one notification, for the highest. Lower thresholds
      // are not sent later either: a key at or above the highest crossed one means it was said.
      const crossed = crossedThresholds(thresholds, line.actual, line.planned);
      if (crossed.length === 0) continue;
      const top = Math.max(...crossed);
      const keyOf = (th: number) => `budget-line:${line.lineId}:${yyyymm}:${th}`;
      const said = await tx
        .select({ id: notification.id })
        .from(notification)
        .where(
          and(
            eq(notification.householdId, householdId),
            inArray(notification.dedupeKey, thresholds.filter((th) => th >= top).map(keyOf)),
          ),
        )
        .limit(1);
      if (said.length > 0) continue;
      const created = await createNotificationInTx(tx, {
        householdId,
        kind: 'budget_line_threshold',
        payload: {
          budgetId,
          lineId: line.lineId,
          monthIndex: month.index,
          threshold: top,
          planned: line.planned,
          actual: line.actual,
        },
        dedupeKey: keyOf(top),
      });
      if (created) result.lineAlerts += 1;
    }
    if (plan.configured && plan.remainingInHub < 0) {
      const created = await createNotificationInTx(tx, {
        householdId,
        kind: 'budget_unallocated_negative',
        payload: { budgetId, monthIndex: month.index, remainingInHub: plan.remainingInHub },
        dedupeKey: `budget-unallocated:${budgetId}:${yyyymm}`,
      });
      if (created) result.unallocatedAlerts += 1;
    }
  });
  return result;
}
