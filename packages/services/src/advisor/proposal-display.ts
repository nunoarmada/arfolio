// What a proposal card needs beyond the draft: the draft carries ids, so the names (goal, budget
// line, category, accounts) and the transaction it would categorise are looked up here. Read-only,
// inside the caller's household transaction.
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Tx } from '@arfolio/db';
import { redactForAi } from '../ai/redact.js';

const { budget, budgetLine, category, financialAccount, goal, transaction } = schema;

/** Names and figures resolved for one proposal; absent fields do not apply to its kind. */
export type ProposalDisplay = {
  /** `goal_update`: the goal the update changes. */
  goalName?: string;
  /** `goal_create`: the account the goal would follow. */
  accountName?: string;
  /** `budget_line_amount`: the line, and the last month (`yyyy-mm`) the new amount reaches. */
  lineName?: string;
  toMonth?: string;
  /** `rule_create`, `transaction_categorise`: the category the rule or row would get. */
  categoryName?: string;
  /** `rule_create`: the accounts the condition is limited to. */
  accountNames?: string[];
  /** `transaction_categorise`: the row, with its description redacted as for the model. */
  transaction?: { bookedOn: string; amount: number; currency: string; description: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `yyyy-mm` eleven months after the `yyyy-mm-dd` budget start: the end of the budget year. */
function lastBudgetMonth(startMonth: string): string {
  const index = Number(startMonth.slice(0, 4)) * 12 + (Number(startMonth.slice(5, 7)) - 1) + 11;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

async function categoryName(tx: Tx, householdId: string, id: string | null) {
  if (!id) return undefined;
  const [row] = await tx
    .select({ name: category.name })
    .from(category)
    .where(and(eq(category.id, id), eq(category.householdId, householdId)));
  return row?.name;
}

async function accountNames(tx: Tx, householdId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: financialAccount.id, name: financialAccount.name })
    .from(financialAccount)
    .where(and(eq(financialAccount.householdId, householdId), inArray(financialAccount.id, ids)));
  return ids.flatMap((id) => rows.filter((r) => r.id === id).map((r) => r.name));
}

/**
 * The display data of a stored proposal, or `null` when there is nothing to resolve (a target
 * that no longer exists shows as the bare draft). Nothing here is trusted: the payload is read
 * defensively.
 */
export async function resolveProposalDisplay(
  tx: Tx,
  householdId: string,
  kind: string,
  payload: unknown,
): Promise<ProposalDisplay | null> {
  const p = isRecord(payload) ? payload : {};
  const out: ProposalDisplay = {};
  switch (kind) {
    case 'goal_create': {
      const [name] = await accountNames(
        tx,
        householdId,
        [str(p.accountId)].filter((v) => v !== null),
      );
      if (name) out.accountName = name;
      break;
    }
    case 'goal_update': {
      const id = str(p.goalId);
      const [row] = id
        ? await tx
            .select({ name: goal.name })
            .from(goal)
            .where(and(eq(goal.id, id), eq(goal.householdId, householdId)))
        : [];
      if (row) out.goalName = row.name;
      break;
    }
    case 'budget_line_amount': {
      const id = str(p.lineId);
      const [row] = id
        ? await tx
            .select({ name: budgetLine.name, startMonth: budget.startMonth })
            .from(budgetLine)
            .innerJoin(budget, eq(budget.id, budgetLine.budgetId))
            .where(and(eq(budgetLine.id, id), eq(budgetLine.householdId, householdId)))
        : [];
      if (row) {
        out.lineName = row.name;
        out.toMonth = lastBudgetMonth(row.startMonth);
      }
      break;
    }
    case 'rule_create': {
      const name = await categoryName(tx, householdId, str(p.categoryId));
      if (name) out.categoryName = name;
      const ids =
        isRecord(p.condition) && Array.isArray(p.condition.accountIds)
          ? p.condition.accountIds.map(str).filter((v) => v !== null)
          : [];
      const names = await accountNames(tx, householdId, ids);
      if (names.length > 0) out.accountNames = names;
      break;
    }
    case 'transaction_categorise': {
      const name = await categoryName(tx, householdId, str(p.categoryId));
      if (name) out.categoryName = name;
      const id = str(p.transactionId);
      const [row] = id
        ? await tx
            .select({
              bookedOn: transaction.purchaseDate,
              amount: transaction.amount,
              currency: transaction.currency,
              description: transaction.rawDescription,
            })
            .from(transaction)
            .where(and(eq(transaction.id, id), eq(transaction.householdId, householdId)))
        : [];
      if (row) {
        out.transaction = {
          bookedOn: row.bookedOn,
          amount: row.amount,
          currency: row.currency,
          description: redactForAi(row.description),
        };
      }
      break;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
