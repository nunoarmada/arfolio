import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import { recordAudit } from './audit.js';
import {
  assertCanWrite,
  assertOwner,
  assertUuid,
  currencyCode,
  isoDate,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';
import { accountBalancesInTx, cardOwed, refreshAllStoredSnapshotsInTx } from './net-worth.js';
import { lockAccountIngest } from './pipeline.js';
import { lockTransfers, unlinkGroupInTx } from './transactions.js';

const { financialAccount, householdSettings, rule, transaction } = schema;

export type Account = typeof financialAccount.$inferSelect;
/**
 * `owed` is what a card owes (see `cardOwed`); null for any other type. `cash` is the money not
 * invested and `invested` the invested part (`cash + invested === balance`).
 */
export type AccountWithBalance = Account & {
  balance: number;
  owed: number | null;
  cash: number;
  invested: number;
};

const accountFields = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(schema.ACCOUNT_TYPES),
  institutionName: z.string().trim().min(1).max(120).nullable(),
  ibanLast4: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/, 'expected the last 4 characters')
    .nullable(),
  openingBalance: z.number().int().safe(),
  openingBalanceDate: isoDate.nullable(),
  includeInBudget: z.boolean(),
  includeInNetWorth: z.boolean(),
  sort: z.number().int().min(0).max(32_767),
  creditLimit: z.number().int().safe().min(0).nullable(),
};

function creditLimitOnNonCard(): ValidationError {
  return new ValidationError('Only a card has a credit limit', [
    { path: ['creditLimit'], message: 'only a card has a credit limit' },
  ]);
}

const createSchema = z.strictObject({
  name: accountFields.name,
  type: accountFields.type,
  currency: currencyCode.optional(),
  institutionName: accountFields.institutionName.optional(),
  ibanLast4: accountFields.ibanLast4.optional(),
  openingBalance: accountFields.openingBalance.optional(),
  openingBalanceDate: accountFields.openingBalanceDate.optional(),
  includeInBudget: accountFields.includeInBudget.optional(),
  includeInNetWorth: accountFields.includeInNetWorth.optional(),
  sort: accountFields.sort.optional(),
  creditLimit: accountFields.creditLimit.optional(),
});

// The currency is fixed once transactions may exist: amounts are stored without conversion.
const patchSchema = z.strictObject({
  name: accountFields.name.optional(),
  type: accountFields.type.optional(),
  institutionName: accountFields.institutionName.optional(),
  ibanLast4: accountFields.ibanLast4.optional(),
  openingBalance: accountFields.openingBalance.optional(),
  openingBalanceDate: accountFields.openingBalanceDate.optional(),
  includeInBudget: accountFields.includeInBudget.optional(),
  includeInNetWorth: accountFields.includeInNetWorth.optional(),
  sort: accountFields.sort.optional(),
  creditLimit: accountFields.creditLimit.optional(),
});

export type CreateAccountInput = z.input<typeof createSchema>;
export type UpdateAccountPatch = z.input<typeof patchSchema>;

/** Far enough ahead that every booked transaction and connector balance is on or before it. */
const END_OF_TIME = '9999-12-31';

/**
 * Accounts with their current `balance`, by the same rule as net worth (`accountBalancesInTx`):
 * positions for an investment account valued by them, else the latest connector balance plus the
 * booked transactions dated after it, else opening balance + the booked transactions dated
 * strictly after the opening date (all of them when there is no opening date). Pending rows are
 * ignored; transfers move real money, so they count.
 */
export async function listAccounts(
  ctx: ServiceCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<AccountWithBalance[]> {
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select()
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.householdId, ctx.householdId),
          opts.includeArchived ? undefined : isNull(financialAccount.archivedAt),
        ),
      )
      .orderBy(financialAccount.sort, financialAccount.name, financialAccount.id);
    const balances = new Map(
      (await accountBalancesInTx(tx, ctx.householdId, END_OF_TIME, { all: true })).map((b) => [
        b.accountId,
        b,
      ]),
    );
    return rows.map((account) => {
      const b = balances.get(account.id);
      const balance = b?.balance ?? 0;
      const owed =
        account.type !== 'card'
          ? null
          : cardOwed({
              balance,
              source: b?.source ?? 'ledger',
              creditLimit: account.creditLimit,
            });
      return {
        ...account,
        balance,
        owed,
        cash: b?.cash ?? 0,
        invested: b?.invested ?? 0,
      };
    });
  });
}

/** Creates an account (no role check; the currency defaults to the household's). */
export async function createAccountInTx(
  tx: Tx,
  householdId: string,
  rawInput: CreateAccountInput,
): Promise<Account> {
  const input = parseInput(createSchema, rawInput);
  if (input.creditLimit != null && input.type !== 'card') throw creditLimitOnNonCard();
  let currency = input.currency;
  if (!currency) {
    const [settings] = await tx
      .select({ currency: householdSettings.currency })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    currency = settings?.currency ?? 'EUR';
  }
  const [row] = await tx
    .insert(financialAccount)
    .values({ ...input, currency, householdId })
    .returning();
  return row!;
}

export async function createAccount(
  ctx: ServiceCtx,
  rawInput: CreateAccountInput,
): Promise<Account> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    createAccountInTx(tx, ctx.householdId, rawInput),
  );
}

export async function updateAccount(
  ctx: ServiceCtx,
  id: string,
  rawPatch: UpdateAccountPatch,
): Promise<Account> {
  assertCanWrite(ctx);
  assertUuid(id, 'Account');
  const patch = parseInput(patchSchema, rawPatch);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const where = and(
      eq(financialAccount.id, id),
      eq(financialAccount.householdId, ctx.householdId),
    );
    // Only a card keeps a credit limit: leaving the card type drops it.
    if (patch.type !== undefined && patch.type !== 'card') {
      if (patch.creditLimit != null) throw creditLimitOnNonCard();
      patch.creditLimit = null;
    } else if (patch.type === undefined && patch.creditLimit != null) {
      const [current] = await tx
        .select({ type: financialAccount.type })
        .from(financialAccount)
        .where(where);
      if (!current) throw new NotFoundError('Account');
      if (current.type !== 'card') throw creditLimitOnNonCard();
    }
    // An empty patch still has to prove the account exists.
    const [row] =
      Object.keys(patch).length === 0
        ? await tx.select().from(financialAccount).where(where)
        : await tx.update(financialAccount).set(patch).where(where).returning();
    if (!row) throw new NotFoundError('Account');
    // What counts in net worth, and from when, changed: the stored month-ends are stale.
    if (
      patch.includeInNetWorth !== undefined ||
      patch.openingBalance !== undefined ||
      patch.openingBalanceDate !== undefined ||
      patch.type !== undefined ||
      patch.creditLimit !== undefined
    ) {
      await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    }
    return row;
  });
}

/** Soft-removes an account (transactions stay). Idempotent: archiving again keeps the first date. */
export async function archiveAccount(ctx: ServiceCtx, id: string): Promise<Account> {
  assertCanWrite(ctx);
  assertUuid(id, 'Account');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const where = and(
      eq(financialAccount.id, id),
      eq(financialAccount.householdId, ctx.householdId),
    );
    const [row] = await tx
      .update(financialAccount)
      .set({ archivedAt: sql`coalesce(${financialAccount.archivedAt}, now())` })
      .where(where)
      .returning();
    if (!row) throw new NotFoundError('Account');
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    return row;
  });
}

/**
 * Rule conditions name accounts in JSON, with no foreign key: remove the deleted account from
 * them. A rule left with no account is disabled, because an empty `accountIds` means every
 * account and would widen the rule.
 */
async function dropAccountFromRulesInTx(tx: Tx, householdId: string, accountId: string) {
  const rows = await tx
    .select({ id: rule.id, condition: rule.condition })
    .from(rule)
    .where(
      and(eq(rule.householdId, householdId), sql`${rule.condition} -> 'accountIds' ? ${accountId}`),
    );
  for (const row of rows) {
    const accountIds = (row.condition.accountIds ?? []).filter((a) => a !== accountId);
    await tx
      .update(rule)
      .set({
        condition: { ...row.condition, accountIds },
        ...(accountIds.length === 0 ? { enabled: false } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(rule.id, row.id));
  }
}

/**
 * Permanently deletes an account and everything that belongs only to it (transactions, balance
 * and position snapshots, import batches, its bank link). Budget lines, goals, assets,
 * liabilities and the hub setting keep their rows and lose the reference, and rules stop naming
 * it. Transfers paired with another account are unlinked first, so the other leg goes back to
 * review. Irreversible; owner only.
 */
export async function deleteAccount(ctx: ServiceCtx, id: string): Promise<void> {
  assertOwner(ctx);
  assertUuid(id, 'Account');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    // Same lock order as ingest and pairing (account ingest, transfers, then rows): an ingest or a
    // pairing in flight finishes first, so its transfer groups are seen and unlinked below.
    await lockAccountIngest(tx, id);
    await lockTransfers(tx, ctx.householdId);
    const where = and(
      eq(financialAccount.id, id),
      eq(financialAccount.householdId, ctx.householdId),
    );
    const [row] = await tx
      .select({ id: financialAccount.id })
      .from(financialAccount)
      .where(where)
      .for('update');
    if (!row) throw new NotFoundError('Account');
    const groups = await tx
      .selectDistinct({ groupId: transaction.transferGroupId })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, ctx.householdId),
          eq(transaction.accountId, id),
          isNotNull(transaction.transferGroupId),
        ),
      );
    for (const { groupId } of groups) {
      if (groupId) await unlinkGroupInTx(tx, ctx.householdId, groupId, { byUser: false });
    }
    await tx.delete(financialAccount).where(where);
    await dropAccountFromRulesInTx(tx, ctx.householdId, id);
    await refreshAllStoredSnapshotsInTx(tx, ctx.householdId);
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'account.delete',
      targetType: 'account',
      targetId: id,
    });
  });
}
