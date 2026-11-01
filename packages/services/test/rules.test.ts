import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveCategory,
  createCategory,
  createCategoryGroup,
  createRule,
  deleteRule,
  ForbiddenError,
  getRule,
  listCategories,
  listRules,
  seedCategoryTemplates,
  NotFoundError,
  suggestRuleFromCorrection,
  updateRule,
  ValidationError,
  type Category,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('rules service', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let cat: Category;
  let accountId: string;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    cat = await createCategory(a, { groupId: group.id, name: 'Groceries' });
    accountId = await withHousehold(a.db, a.householdId, async (tx) => {
      const [acc] = await tx
        .insert(schema.financialAccount)
        .values({ householdId: a.householdId, name: 'Main', type: 'checking' })
        .returning();
      return acc!.id;
    });
  });
  afterAll(() => t.close());

  it('creates rules with an incrementing default priority and records the author', async () => {
    const r1 = await createRule(a, {
      name: 'Shops',
      condition: { descriptionContains: 'shop' },
      categoryId: cat.id,
    });
    const r2 = await createRule(a, {
      name: 'Big',
      condition: { amountMax: -10_000, direction: 'out' },
      categoryId: cat.id,
    });
    expect(r1).toMatchObject({ enabled: true, createdBy: 'user-1', householdId: a.householdId });
    expect(r2.priority).toBeGreaterThan(r1.priority);
    expect((await listRules(a)).map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect((await getRule(a, r1.id)).name).toBe('Shops');
  });

  it('validates the wildcard pattern and the condition', async () => {
    const base = { name: 'x', categoryId: cat.id };
    await expect(
      createRule(a, { ...base, condition: { descriptionPattern: '' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createRule(a, { ...base, condition: { descriptionPattern: 'a'.repeat(201) } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createRule(a, { ...base, condition: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createRule(a, { ...base, condition: { amountMin: 5, amountMax: 1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createRule(a, { ...base, condition: { descriptionContains: 'x', bogus: 1 } as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await createRule(a, { ...base, condition: { descriptionPattern: 'PING*DOCE ?' } });
    expect(ok.condition.descriptionPattern).toBe('PING*DOCE ?');
  });

  it('rejects archived categories on create and update', async () => {
    const group = await createCategoryGroup(a, { name: 'Arch', kind: 'expense' });
    const old = await createCategory(a, { groupId: group.id, name: 'Old' });
    const live = await createRule(a, {
      name: 'live',
      condition: { descriptionContains: 'zz' },
      categoryId: cat.id,
    });
    await archiveCategory(a, old.id);
    await expect(
      createRule(a, { name: 'x', condition: { descriptionContains: 'x' }, categoryId: old.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateRule(a, live.id, { categoryId: old.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects the transfer category on create and update', async () => {
    const owner = await t.household();
    await seedCategoryTemplates(owner, 'en');
    const transferCat = (await listCategories(owner)).find((g) => g.kind === 'transfer')!
      .categories[0]!;
    const group = await createCategoryGroup(owner, { name: 'G', kind: 'expense' });
    const normal = await createCategory(owner, { groupId: group.id, name: 'Normal' });
    const live = await createRule(owner, {
      name: 'live',
      condition: { descriptionContains: 'zz' },
      categoryId: normal.id,
    });
    await expect(
      createRule(owner, {
        name: 'x',
        condition: { descriptionContains: 'x' },
        categoryId: transferCat.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateRule(owner, live.id, { categoryId: transferCat.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await getRule(owner, live.id)).categoryId).toBe(normal.id);

    // Even if the category were moved out of the transfer group, its template key still blocks it.
    await withHousehold(owner.db, owner.householdId, (tx) =>
      tx
        .update(schema.category)
        .set({ groupId: group.id })
        .where(eq(schema.category.id, transferCat.id)),
    );
    await expect(
      createRule(owner, {
        name: 'y',
        condition: { descriptionContains: 'y' },
        categoryId: transferCat.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a category from another household', async () => {
    await expect(
      createRule(b, { name: 'x', condition: { descriptionContains: 'x' }, categoryId: cat.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('updates and deletes rules', async () => {
    const r = await createRule(a, {
      name: 'Upd',
      condition: { descriptionContains: 'upd' },
      categoryId: cat.id,
    });
    const updated = await updateRule(a, r.id, {
      enabled: false,
      priority: 1,
      condition: { descriptionPattern: 'upd*' },
    });
    expect(updated).toMatchObject({ enabled: false, priority: 1 });
    expect(updated.condition).toEqual({ descriptionPattern: 'upd*' });
    await expect(
      updateRule(a, r.id, { condition: { descriptionPattern: '' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await deleteRule(a, r.id);
    await expect(getRule(a, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('suggests a rule from a correction using the counterparty, else the merchant key', async () => {
    const [withCp, without] = await withHousehold(a.db, a.householdId, (tx) =>
      tx
        .insert(schema.transaction)
        .values(
          [
            {
              dedupeHash: 's1',
              rawDescription: 'COMPRA 1234 SUPER MARKET 12/03',
              counterparty: 'Super Market',
            },
            { dedupeHash: 's2', rawDescription: 'COMPRA 99/12 Corner Bakery', counterparty: null },
          ].map((x) => ({
            ...x,
            householdId: a.householdId,
            accountId,
            bookingDate: '2026-03-12',
            amount: -500,
            currency: 'EUR',
            status: 'booked' as const,
            source: 'manual' as const,
            categoryId: cat.id,
            categorisedBy: 'user' as const,
          })),
        )
        .returning(),
    );
    const d1 = await suggestRuleFromCorrection(a, withCp!.id);
    expect(d1).toEqual({
      name: 'Super Market',
      condition: { counterpartyContains: 'Super Market' },
      categoryId: cat.id,
    });
    const d2 = await suggestRuleFromCorrection(a, without!.id);
    expect(d2.condition).toEqual({ descriptionContains: 'CORNER BAKERY' });
    expect(d2.categoryId).toBe(cat.id);
    // A draft is accepted as-is by createRule.
    const created = await createRule(a, {
      name: d2.name,
      condition: d2.condition,
      categoryId: d2.categoryId!,
    });
    expect(created.condition).toEqual(d2.condition);
  });

  it('isolates households on every get/update/delete/suggest', async () => {
    const r = (await listRules(a))[0]!;
    await expect(getRule(b, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateRule(b, r.id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteRule(b, r.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(suggestRuleFromCorrection(b, r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listRules(b)).toEqual([]);
  });

  it('forbids writes for viewers', async () => {
    const viewer = withRole(a, 'viewer');
    const r = (await listRules(a))[0]!;
    await expect(
      createRule(viewer, {
        name: 'x',
        condition: { descriptionContains: 'x' },
        categoryId: cat.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateRule(viewer, r.id, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteRule(viewer, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listRules(viewer)).length).toBeGreaterThan(0);
  });
});
