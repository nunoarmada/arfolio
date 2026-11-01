import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveCategory,
  archiveCategoryGroup,
  backfillHouseholdDefaults,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  createRule,
  deleteCategory,
  deleteCategoryGroup,
  ensureHouseholdDefaults,
  ForbiddenError,
  linkCategories,
  listCategories,
  listRules,
  NotFoundError,
  resolveTemplateLocale,
  seedCategoryTemplates,
  TEMPLATE_LOCALES,
  updateCategory,
  updateCategoryGroup,
  upsertBudgetLine,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const PT: Array<[string, string[]]> = [
  [
    'Receitas',
    [
      'Salário',
      'Subsídios e apoios',
      'Rendas recebidas',
      'Juros e dividendos',
      'Reembolsos',
      'Outras receitas',
    ],
  ],
  [
    'Habitação',
    [
      'Prestação/renda',
      'Condomínio',
      'Água, luz e gás',
      'Comunicações',
      'Seguros da casa',
      'Manutenção',
    ],
  ],
  ['Alimentação', ['Supermercado', 'Restaurantes e cafés', 'Almoço de trabalho']],
  [
    'Transportes',
    [
      'Combustível',
      'Portagens',
      'Estacionamento',
      'Transportes públicos',
      'Manutenção automóvel',
      'Seguro automóvel',
    ],
  ],
  ['Filhos', ['Escola', 'Atividades', 'Mesada', 'Roupa e calçado', 'Saúde dos filhos']],
  ['Pessoal', ['Saúde', 'Roupa e calçado', 'Cuidados pessoais', 'Desporto', 'Formação']],
  ['Obrigações', ['Impostos', 'Segurança Social', 'Dívidas e créditos', 'Comissões bancárias']],
  [
    'Lazer e outros',
    ['Subscrições', 'Viagens', 'Lazer', 'Prendas', 'Compras online', 'Extras', 'Outros'],
  ],
  ['Poupança', ['Fundo de emergência', 'Investimentos', 'Objetivos']],
  ['Transferências', ['Entre contas']],
];

describe('category templates and categories service', () => {
  let t: ServicesTestDb;
  let pt: ServiceCtx;
  let en: ServiceCtx;
  let other: ServiceCtx;

  beforeAll(async () => {
    t = await startServicesDb();
    pt = await t.household({ locale: 'pt-PT' });
    en = await t.household({ locale: 'en' });
    other = await t.household();
  });
  afterAll(() => t.close());

  it('resolves supported locales and falls back to en', () => {
    for (const locale of TEMPLATE_LOCALES) expect(resolveTemplateLocale(locale)).toBe(locale);
    expect([...TEMPLATE_LOCALES]).toEqual(['pt-PT', 'es-ES', 'fr-FR', 'it-IT', 'en']);
    expect(resolveTemplateLocale('pt-BR')).toBe('pt-PT');
    expect(resolveTemplateLocale('es-MX')).toBe('es-ES');
    expect(resolveTemplateLocale('fr')).toBe('fr-FR');
    expect(resolveTemplateLocale('it_CH')).toBe('it-IT');
    expect(resolveTemplateLocale('de')).toBe('en');
    expect(resolveTemplateLocale('')).toBe('en');
  });

  it('seeds the pt-PT templates with the exact group and category names', async () => {
    await seedCategoryTemplates(pt, 'pt-PT');
    const groups = await listCategories(pt);
    expect(groups.map((g) => [g.name, g.categories.map((c) => c.name)])).toEqual(PT);
  });

  it('seeds en equivalents, with kinds and template keys', async () => {
    await seedCategoryTemplates(en, 'en');
    const groups = await listCategories(en);
    expect(groups).toHaveLength(10);
    expect(groups.map((g) => g.kind)).toEqual([
      'income',
      'expense',
      'expense',
      'expense',
      'expense',
      'expense',
      'expense',
      'expense',
      'saving',
      'transfer',
    ]);
    const transfers = groups.at(-1)!;
    expect(transfers.categories).toHaveLength(1);
    expect(transfers.categories[0]).toMatchObject({ templateKey: 'transfer.between_accounts' });
    expect(groups.flatMap((g) => g.categories).every((c) => c.templateKey)).toBe(true);
    expect(groups.flatMap((g) => g.categories.map((c) => c.name))).not.toContain('Salário');
  });

  it('is idempotent: seeding twice creates nothing new and keeps renames', async () => {
    const before = await listCategories(pt);
    const first = before[0]!;
    await updateCategoryGroup(pt, first.id, { name: 'Rendimentos' });
    const result = await seedCategoryTemplates(pt, 'pt-PT');
    expect(result).toEqual({ groupsCreated: 0, categoriesCreated: 0 });
    const after = await listCategories(pt);
    expect(after.flatMap((g) => g.categories)).toHaveLength(
      before.flatMap((g) => g.categories).length,
    );
    expect(after[0]!.name).toBe('Rendimentos');
  });

  it('seeds concurrently without duplicates', async () => {
    const ctx = await t.household({ locale: 'en' });
    await Promise.all([seedCategoryTemplates(ctx, 'en'), seedCategoryTemplates(ctx, 'en')]);
    expect(await listCategories(ctx)).toHaveLength(10);
  });

  it('creates, updates and archives groups and categories', async () => {
    const ctx = await t.household();
    const group = await createCategoryGroup(ctx, { name: 'Pets', kind: 'expense' });
    const cat = await createCategory(ctx, { groupId: group.id, name: 'Vet', icon: 'paw' });
    expect(cat).toMatchObject({ name: 'Vet', icon: 'paw', groupId: group.id });
    const renamed = await updateCategory(ctx, cat.id, { name: 'Veterinary' });
    expect(renamed.name).toBe('Veterinary');

    await archiveCategory(ctx, cat.id);
    expect((await listCategories(ctx))[0]!.categories).toEqual([]);
    expect((await listCategories(ctx, { includeArchived: true }))[0]!.categories).toHaveLength(1);

    await archiveCategoryGroup(ctx, group.id);
    expect(await listCategories(ctx)).toEqual([]);
    expect(await listCategories(ctx, { includeArchived: true })).toHaveLength(1);
  });

  it('rejects categories in unknown groups and invalid input', async () => {
    const ctx = await t.household();
    await expect(
      createCategory(ctx, { groupId: '00000000-0000-4000-8000-000000000000', name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(createCategoryGroup(ctx, { name: ' ', kind: 'expense' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createCategoryGroup(ctx, { name: 'x', kind: 'nope' as never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([{ reassign: false }, { reassign: true }])(
    'deleting a category clears AI suggestions pointing at it (reassign: $reassign)',
    async ({ reassign }) => {
      const ctx = await t.household();
      const group = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
      const suggested = await createCategory(ctx, { groupId: group.id, name: 'Suggested' });
      const other = await createCategory(ctx, { groupId: group.id, name: 'Other' });
      const account = await createAccount(ctx, { name: 'Acc', type: 'checking' });
      const txn = await createManualTransaction(ctx, {
        accountId: account.id,
        bookingDate: '2026-02-01',
        amount: -100,
        description: 'Thing',
      });
      await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx
          .update(schema.transaction)
          .set({ aiSuggestedCategoryId: suggested.id, aiConfidence: 0.7 })
          .where(eq(schema.transaction.id, txn.id)),
      );

      await deleteCategory(ctx, suggested.id, reassign ? { reassignTo: other.id } : {});

      const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.select().from(schema.transaction).where(eq(schema.transaction.id, txn.id)),
      );
      expect(row).toMatchObject({ aiSuggestedCategoryId: null, aiConfidence: null });
    },
  );

  it('deleting a category without a target lets the AI categorise its rows again', async () => {
    const ctx = await t.household();
    const group = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
    const doomed = await createCategory(ctx, { groupId: group.id, name: 'Doomed' });
    const account = await createAccount(ctx, { name: 'Acc', type: 'checking' });
    const mk = async (description: string) =>
      (
        await createManualTransaction(ctx, {
          accountId: account.id,
          bookingDate: '2026-02-01',
          amount: -100,
          description,
        })
      ).id;
    const ai = await mk('AI one');
    const mine = await mk('Mine');
    const rows = (ids: string[], set: Partial<typeof schema.transaction.$inferInsert>) =>
      withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.update(schema.transaction).set(set).where(inArray(schema.transaction.id, ids)),
      );
    await rows([ai, mine], {
      categoryId: doomed.id,
      categorisedBy: 'ai',
      aiConfidence: 0.9,
      aiAttempts: 3,
    });
    await rows([mine], { categorisedBy: 'user', userEditedAt: new Date() });

    await deleteCategory(ctx, doomed.id);

    const read = async (id: string) =>
      (
        await withHousehold(ctx.db, ctx.householdId, (tx) =>
          tx.select().from(schema.transaction).where(eq(schema.transaction.id, id)),
        )
      )[0]!;
    expect(await read(ai)).toMatchObject({ categoryId: null, aiAttempts: 0, aiConfidence: null });
    expect(await read(mine)).toMatchObject({ categoryId: null, aiAttempts: 3 });
  });

  it('deleting a category re-homes transactions, merchants and rules, or clears them', async () => {
    const ctx = await t.household();
    const group = await createCategoryGroup(ctx, { name: 'G', kind: 'expense' });
    const from = await createCategory(ctx, { groupId: group.id, name: 'From' });
    const to = await createCategory(ctx, { groupId: group.id, name: 'To' });
    const account = await createAccount(ctx, { name: 'Acc', type: 'checking' });
    const tx1 = await createManualTransaction(ctx, {
      accountId: account.id,
      bookingDate: '2026-02-01',
      amount: -100,
      description: 'Thing',
      categoryId: from.id,
    });
    await createRule(ctx, {
      name: 'r',
      condition: { descriptionContains: 'thing' },
      categoryId: from.id,
    });
    await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx.insert(schema.merchant).values({
        householdId: ctx.householdId,
        key: 'thing',
        displayName: 'Thing',
        defaultCategoryId: from.id,
      }),
    );

    await deleteCategory(ctx, from.id, { reassignTo: to.id });
    const row = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
      const [x] = await tx
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.id, tx1.id));
      const [m] = await tx.select().from(schema.merchant);
      return { x, m };
    });
    expect(row.x!.categoryId).toBe(to.id);
    expect(row.m!.defaultCategoryId).toBe(to.id);
    expect((await listRules(ctx))[0]!.categoryId).toBe(to.id);

    // Without a target: transactions go back to the inbox, rules are removed, merchants forgotten.
    await deleteCategory(ctx, to.id);
    const after = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
      const [x] = await tx
        .select()
        .from(schema.transaction)
        .where(eq(schema.transaction.id, tx1.id));
      const [m] = await tx.select().from(schema.merchant);
      return { x, m };
    });
    expect(after.x).toMatchObject({ categoryId: null, categorisedBy: null, needsReview: true });
    expect(after.m!.defaultCategoryId).toBeNull();
    expect(await listRules(ctx)).toEqual([]);
    expect((await listCategories(ctx))[0]!.categories).toEqual([]);
  });

  it('only allows deleting empty, non-template groups and non-template categories', async () => {
    const ctx = await t.household({ locale: 'en' });
    await seedCategoryTemplates(ctx, 'en');
    const [income] = await listCategories(ctx);
    await expect(deleteCategoryGroup(ctx, income!.id)).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteCategory(ctx, income!.categories[0]!.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    const group = await createCategoryGroup(ctx, { name: 'Custom', kind: 'expense' });
    const cat = await createCategory(ctx, { groupId: group.id, name: 'Inner' });
    await expect(deleteCategoryGroup(ctx, group.id)).rejects.toBeInstanceOf(ValidationError);
    await deleteCategory(ctx, cat.id);
    await deleteCategoryGroup(ctx, group.id);
    await expect(deleteCategoryGroup(ctx, group.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to reassign a deleted category into the transfer category', async () => {
    const ctx = await t.household({ locale: 'en' });
    await seedCategoryTemplates(ctx, 'en');
    const transfer = (await listCategories(ctx))
      .flatMap((g) => g.categories)
      .find((c) => c.templateKey === 'transfer.between_accounts')!;
    const group = await createCategoryGroup(ctx, { name: 'Custom', kind: 'expense' });
    const cat = await createCategory(ctx, { groupId: group.id, name: 'Inner' });
    await expect(deleteCategory(ctx, cat.id, { reassignTo: transfer.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // Nothing was deleted.
    expect((await listCategories(ctx)).flatMap((g) => g.categories).map((c) => c.id)).toContain(
      cat.id,
    );
  });

  it('only reassigns into a category of the same group kind', async () => {
    const ctx = await t.household({ locale: 'en' });
    await seedCategoryTemplates(ctx, 'en');
    const spend = await createCategoryGroup(ctx, { name: 'Spend', kind: 'expense' });
    const earn = await createCategoryGroup(ctx, { name: 'Earn', kind: 'income' });
    const other = await createCategoryGroup(ctx, { name: 'Other spend', kind: 'expense' });
    const from = await createCategory(ctx, { groupId: spend.id, name: 'From' });
    const income = await createCategory(ctx, { groupId: earn.id, name: 'Pay' });
    const sameKind = await createCategory(ctx, { groupId: other.id, name: 'To' });
    await expect(deleteCategory(ctx, from.id, { reassignTo: income.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await deleteCategory(ctx, from.id, { reassignTo: sameKind.id });
  });

  it('moves budget links to the reassign target unless the target is already linked there', async () => {
    const ctx = await t.household({ locale: 'en' });
    await seedCategoryTemplates(ctx, 'en');
    const group = await createCategoryGroup(ctx, { name: 'Custom', kind: 'expense' });
    const from = await createCategory(ctx, { groupId: group.id, name: 'From' });
    const to = await createCategory(ctx, { groupId: group.id, name: 'To' });
    // Budget 1: only `from` is linked, so its link moves. Budget 2: `to` is linked on another
    // line already, so `from`'s link goes away with the category.
    const b1 = await createBudget(ctx, { startMonth: '2026-01-01' });
    const l1 = await upsertBudgetLine(ctx, b1.id, { kind: 'expense', name: 'One' });
    await linkCategories(ctx, l1.id, [from.id]);
    const b2 = await createBudget(ctx, { startMonth: '2025-01-01' });
    const l2a = await upsertBudgetLine(ctx, b2.id, { kind: 'expense', name: 'Two A' });
    const l2b = await upsertBudgetLine(ctx, b2.id, { kind: 'expense', name: 'Two B' });
    await linkCategories(ctx, l2a.id, [from.id]);
    await linkCategories(ctx, l2b.id, [to.id]);

    await deleteCategory(ctx, from.id, { reassignTo: to.id });

    const links = await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx.select().from(schema.budgetLineCategory),
    );
    const pairs = links.map((l) => `${l.budgetLineId}:${l.categoryId}`).sort();
    expect(pairs).toEqual([`${l1.id}:${to.id}`, `${l2b.id}:${to.id}`].sort());
  });

  it('isolates households on every get/update/delete', async () => {
    const group = (await listCategories(pt))[1]!;
    const cat = group.categories[0]!;
    await expect(updateCategoryGroup(other, group.id, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(archiveCategoryGroup(other, group.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCategoryGroup(other, group.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCategory(other, cat.id, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(archiveCategory(other, cat.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCategory(other, cat.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createCategory(other, { groupId: group.id, name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await listCategories(other)).toEqual([]);
  });

  it('forbids every write for viewers', async () => {
    const viewer = withRole(pt, 'viewer');
    const group = (await listCategories(pt))[1]!;
    const cat = group.categories[0]!;
    const calls = [
      seedCategoryTemplates(viewer, 'pt-PT'),
      createCategoryGroup(viewer, { name: 'x', kind: 'expense' }),
      updateCategoryGroup(viewer, group.id, { name: 'x' }),
      archiveCategoryGroup(viewer, group.id),
      deleteCategoryGroup(viewer, group.id),
      createCategory(viewer, { groupId: group.id, name: 'x' }),
      updateCategory(viewer, cat.id, { name: 'x' }),
      archiveCategory(viewer, cat.id),
      deleteCategory(viewer, cat.id),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listCategories(viewer)).length).toBeGreaterThan(0);
  });

  it('backfills households without templates in their locale, once', async () => {
    const lonePt = await t.household({ locale: 'pt-PT' });
    const loneFr = await t.household({ locale: 'fr' });
    const loneDe = await t.household({ locale: 'de' });
    const count = (ctx: ServiceCtx) =>
      withHousehold(ctx.db, ctx.householdId, async (tx) =>
        (await tx.select().from(schema.categoryGroup)).map((g) => g.name),
      );

    const seeded = await backfillHouseholdDefaults(lonePt.db);
    expect(seeded).toBeGreaterThanOrEqual(2);
    expect((await count(lonePt))[0]).toBe('Receitas');
    expect(await count(loneFr)).toContain('Revenus');
    expect(await count(loneDe)).toContain('Income');

    // A household that already has templates is left alone, even after the user deleted one.
    const custom = (await listCategories(lonePt))[0]!;
    await archiveCategoryGroup(lonePt, custom.id);
    expect(await backfillHouseholdDefaults(lonePt.db)).toBe(0);
    expect((await count(lonePt)).length).toBe(10);
  });

  it('never lets callers create, edit into or fill the transfer group', async () => {
    const owner = await t.household();
    await seedCategoryTemplates(owner, 'en');
    const groups = await listCategories(owner);
    const transferGroup = groups.find((g) => g.kind === 'transfer')!;
    const expense = await createCategoryGroup(owner, { name: 'Mine', kind: 'expense' });
    const mine = await createCategory(owner, { groupId: expense.id, name: 'Mine cat' });

    await expect(
      createCategoryGroup(owner, { name: 'T', kind: 'transfer' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateCategoryGroup(owner, expense.id, { kind: 'transfer' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCategory(owner, { groupId: transferGroup.id, name: 'Sneaky' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateCategory(owner, mine.id, { groupId: transferGroup.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The seeded transfer group/category themselves cannot be converted or moved; renaming is fine.
    const transferCat = transferGroup.categories[0]!;
    await expect(
      updateCategoryGroup(owner, transferGroup.id, { kind: 'expense' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateCategory(owner, transferCat.id, { groupId: expense.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateCategoryGroup(owner, transferGroup.id, { name: 'Between accounts (renamed)' }),
    ).resolves.toMatchObject({ kind: 'transfer', name: 'Between accounts (renamed)' });
    await expect(
      updateCategory(owner, transferCat.id, { name: 'Moves (renamed)' }),
    ).resolves.toMatchObject({ name: 'Moves (renamed)' });
    expect(
      (await listCategories(owner)).find((g) => g.kind === 'transfer')!.categories,
    ).toHaveLength(1);
  });

  describe('ensureHouseholdDefaults', () => {
    const groupNames = (ctx: ServiceCtx) =>
      withHousehold(ctx.db, ctx.householdId, async (tx) =>
        (await tx.select({ name: schema.categoryGroup.name }).from(schema.categoryGroup)).map(
          (g) => g.name,
        ),
      );

    it('seeds a writer household that has no template groups, in its locale, once', async () => {
      const lone = await t.household({ locale: 'pt-PT' });
      expect(await ensureHouseholdDefaults(lone)).toBe(true);
      expect((await groupNames(lone)).length).toBe(10);
      expect(await groupNames(lone)).toContain('Receitas');
      expect(await ensureHouseholdDefaults(lone)).toBe(false);
      expect((await groupNames(lone)).length).toBe(10);
    });

    it('does nothing for viewers', async () => {
      const lone = await t.household();
      expect(await ensureHouseholdDefaults(withRole(lone, 'viewer'))).toBe(false);
      expect(await groupNames(lone)).toEqual([]);
    });

    it('seeds exactly once under concurrent calls', async () => {
      const lone = await t.household();
      await Promise.all([ensureHouseholdDefaults(lone), ensureHouseholdDefaults(lone)]);
      const names = await groupNames(lone);
      expect(names.length).toBe(new Set(names).size);
      expect(names.length).toBe(10);
    });
  });
});
