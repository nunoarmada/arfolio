import type { ServiceCtx } from '../context.js';
import { budgetMonthView, listBudgets, type BudgetMonthView } from '../budgets.js';

/** 1-based position of `month` (`yyyy-mm`) in the budget year starting at `startMonth` (`yyyy-mm-01`). */
function monthIndexOf(startMonth: string, month: string): number {
  const abs = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  return abs(month) - abs(startMonth.slice(0, 7)) + 1;
}

/**
 * The month view of the active budget whose 12-month year covers `month` (`yyyy-mm`), or null
 * when no budget does. Reuses `listBudgets` and `budgetMonthView`; nothing is recomputed here.
 */
export async function coveringBudgetView(
  ctx: ServiceCtx,
  month: string,
): Promise<BudgetMonthView | null> {
  for (const b of await listBudgets(ctx)) {
    if (b.status !== 'active') continue;
    const index = monthIndexOf(b.startMonth, month);
    if (index >= 1 && index <= 12) return budgetMonthView(ctx, b.id, index);
  }
  return null;
}
