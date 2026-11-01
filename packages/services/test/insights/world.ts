import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  seedCategoryTemplates,
} from '../../src/index.js';
import { findTransferCategory } from '../../src/transactions.js';
import type { ServicesTestDb } from '../helpers.js';

const { transaction, householdSettings, recurring, notification } = schema;

let hash = 0;

/** A household with expense categories and helpers to arrange rows as the table owner. */
export async function insightsWorld(
  t: ServicesTestDb,
  opts: { timezone?: string; currency?: string; locale?: string } = {},
) {
  const ctx = await t.household({ currency: opts.currency ?? 'EUR', locale: opts.locale ?? 'en' });
  await t.owner
    .update(householdSettings)
    .set({ timezone: opts.timezone ?? 'UTC' })
    .where(eq(householdSettings.householdId, ctx.householdId));
  await seedCategoryTemplates(ctx, 'en');
  const transferId = (await withHousehold(ctx.db, ctx.householdId, (tx) =>
    findTransferCategory(tx, ctx.householdId),
  ))!;
  const main = (await createAccount(ctx, { name: 'Main', type: 'checking' })).id;
  const savings = (await createAccount(ctx, { name: 'Savings', type: 'savings' })).id;
  const gFood = await createCategoryGroup(ctx, { name: 'Food', kind: 'expense' });
  const gHome = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
  const gPay = await createCategoryGroup(ctx, { name: 'Pay', kind: 'income' });
  const cats = {
    groceries: (await createCategory(ctx, { groupId: gFood.id, name: 'Groceries' })).id,
    dining: (await createCategory(ctx, { groupId: gFood.id, name: 'Dining' })).id,
    rent: (await createCategory(ctx, { groupId: gHome.id, name: 'Rent' })).id,
    salary: (await createCategory(ctx, { groupId: gPay.id, name: 'Salary' })).id,
  };
  const add = (
    accountId: string,
    bookingDate: string,
    amount: number,
    extra: {
      categoryId?: string;
      transferGroupId?: string;
      currency?: string;
      status?: 'booked' | 'pending';
      description?: string;
    } = {},
  ) =>
    t.owner.insert(transaction).values({
      householdId: ctx.householdId,
      accountId,
      dedupeHash: `w${(hash += 1)}`,
      bookingDate,
      amount,
      currency: extra.currency ?? 'EUR',
      status: extra.status ?? 'booked',
      rawDescription: extra.description ?? 'x',
      source: 'manual',
      ...(extra.categoryId ? { categoryId: extra.categoryId } : {}),
      ...(extra.transferGroupId ? { transferGroupId: extra.transferGroupId } : {}),
    });
  /** Spends `amount` (minor, positive) on `categoryId` once in each of the given `yyyy-mm` months. */
  const spendIn = async (categoryId: string, months: string[], amount: number) => {
    for (const m of months) await add(main, `${m}-10`, -amount, { categoryId });
  };
  const addRecurring = (v: {
    name: string;
    amount: number;
    cadence?: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    status?: 'detected' | 'confirmed' | 'dismissed';
    source?: 'detected' | 'declared' | 'import';
    createdAt: Date;
    currency?: string;
    categoryId?: string;
  }) =>
    t.owner
      .insert(recurring)
      .values({
        householdId: ctx.householdId,
        merchantKey: `d:${v.name.toLowerCase()}:${randomUUID()}`,
        name: v.name,
        amount: v.amount,
        currency: v.currency ?? 'EUR',
        cadence: v.cadence ?? 'monthly',
        status: v.status ?? 'detected',
        source: v.source ?? 'detected',
        createdAt: v.createdAt,
        ...(v.categoryId ? { categoryId: v.categoryId } : {}),
      })
      .returning();
  const addPriceChange = (p: {
    name: string;
    previousAmount: number;
    amount: number;
    date: string;
    currency?: string;
    recurringId?: string;
  }) =>
    t.owner.insert(notification).values({
      householdId: ctx.householdId,
      kind: 'recurring_price_change',
      payload: { recurringId: randomUUID(), currency: 'EUR', ...p },
      dedupeKey: `recurring-price:${randomUUID()}`,
    });
  return {
    ctx,
    transferId,
    main,
    savings,
    groups: { food: gFood.id, home: gHome.id, pay: gPay.id },
    cats,
    add,
    spendIn,
    addRecurring,
    addPriceChange,
  };
}

/** The six months before 2026-09, oldest first. */
export const PRIOR = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
