import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeDescription } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import {
  commitBudgetImport,
  ConflictError,
  createAccount,
  createCategory,
  archiveCategory,
  createCategoryGroup,
  ensureHouseholdDefaults,
  ForbiddenError,
  getBudget,
  listAccounts,
  listBudgets,
  listCategories,
  NotFoundError,
  previewBudgetImport,
  runRecurringDetection,
  upsertBudgetLine,
  ValidationError,
  type BudgetImportChoices,
  type ServiceCtx,
} from '../../src/index.js';
import { buildBudgetSheet, zipBomb, type BudgetSheetOptions } from '../fixtures/budget-sheet.js';
import { startServicesDb, withRole, type ServicesTestDb } from '../helpers.js';

const { recurring, transaction, undoToken, householdSettings, budget } = schema;

const ALL: BudgetImportChoices = {
  createMissingAccounts: true,
  createMissingGroups: true,
  replaceExisting: false,
};
const flat = (n: number): number[] => Array.from({ length: 12 }, () => n);

describe('budget spreadsheet import', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const file = async (opts?: BudgetSheetOptions, fileName = 'orcamento.xlsx') => ({
    fileName,
    bytes: await buildBudgetSheet(opts),
  });
  const inHousehold = <T>(ctx: ServiceCtx, fn: Parameters<typeof withHousehold<T>>[2]) =>
    withHousehold(ctx.db, ctx.householdId, fn);
  const importRows = (ctx: ServiceCtx) =>
    inHousehold(ctx, (tx) =>
      tx.select().from(recurring).where(eq(recurring.householdId, ctx.householdId)),
    );
  const tokens = (ctx: ServiceCtx) =>
    inHousehold(ctx, (tx) =>
      tx.select().from(undoToken).where(eq(undoToken.kind, 'budget_import')),
    );

  /** What a commit may write, counted, to prove a refused commit wrote nothing. */
  async function footprint(ctx: ServiceCtx) {
    const categories = await listCategories(ctx, { includeArchived: true });
    return {
      accounts: (await listAccounts(ctx, { includeArchived: true })).length,
      groups: categories.length,
      categories: categories.reduce((n, g) => n + g.categories.length, 0),
      budgets: (await listBudgets(ctx)).length,
      recurring: (await importRows(ctx)).length,
    };
  }

  async function importAll(ctx: ServiceCtx, opts?: BudgetSheetOptions, choices = ALL) {
    const preview = await previewBudgetImport(ctx, await file(opts));
    const result = await commitBudgetImport(ctx, preview.token, choices);
    return { preview, result };
  }

  describe('previewBudgetImport', () => {
    it('shows the budget to import as plain JSON and writes nothing but the token', async () => {
      const ctx = await t.household({ locale: 'pt-PT' });
      const before = await footprint(ctx);
      const preview = await previewBudgetImport(ctx, await file());

      expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
      expect(preview).toMatchObject({
        startMonth: '2026-10-01',
        budgetName: 'Orçamento 2026/27',
        existingBudgetId: null,
        emergencyFundMonths: 6,
        subscriptionsSkipped: 1,
        warnings: [],
      });
      expect(preview.lines).toHaveLength(7);
      expect(preview.subscriptions).toHaveLength(4);
      expect(preview.accounts.map((a) => a.name)).toEqual([
        'Conta Principal',
        'Conta Poupança',
        'Cartão A',
      ]);
      expect(preview.groups).toEqual([
        { name: 'Habitação', kind: 'expense', match: null },
        { name: 'Alimentação', kind: 'expense', match: null },
        { name: 'Lazer', kind: 'expense', match: null },
      ]);
      expect(await footprint(ctx)).toEqual(before);
      expect(await tokens(ctx)).toHaveLength(1);
    });

    it('matches accounts and groups by name ignoring case, accents and spaces', async () => {
      const ctx = await t.household();
      const main = await createAccount(ctx, { name: '  conta PRINCIPAL ', type: 'checking' });
      const card = await createAccount(ctx, { name: 'Cartao a', type: 'card' });
      const archived = await createAccount(ctx, { name: 'Conta Poupança', type: 'savings' });
      await inHousehold(ctx, (tx) =>
        tx
          .update(schema.financialAccount)
          .set({ archivedAt: new Date() })
          .where(eq(schema.financialAccount.id, archived.id)),
      );
      const housing = await createCategoryGroup(ctx, { name: 'habitacao', kind: 'expense' });
      await createCategoryGroup(ctx, { name: 'Alimentação', kind: 'income' }); // wrong kind

      const preview = await previewBudgetImport(ctx, await file());
      expect(preview.accounts).toEqual([
        { name: 'Conta Principal', match: main.id },
        { name: 'Conta Poupança', match: null },
        { name: 'Cartão A', match: card.id },
      ]);
      expect(preview.groups.map((g) => g.match)).toEqual([housing.id, null, null]);
    });

    it('reports the budget already there for the same start month', async () => {
      const ctx = await t.household();
      const { result } = await importAll(ctx);
      const preview = await previewBudgetImport(ctx, await file());
      expect(preview.existingBudgetId).toBe(result.budgetId);
    });

    it('passes the parser warnings through as codes', async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(
        ctx,
        await file({ renameHeader: { index: 0, text: 'x 1' }, emptySection: 'Poupança' }),
      );
      expect(preview.warnings).toEqual([
        { code: 'month_header_mismatch', params: { section: 'Receitas' } },
        { code: 'empty_section', params: { section: 'Poupança' } },
      ]);
    });

    it('refuses viewers, wrong file types and hostile files without storing a token', async () => {
      const ctx = await t.household();
      await expect(
        previewBudgetImport(withRole(ctx, 'viewer'), await file()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        previewBudgetImport(ctx, await file(undefined, 'orcamento.csv')),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'unreadable_file' });
      await expect(
        previewBudgetImport(ctx, { fileName: 'bomb.xlsx', bytes: zipBomb(150 * 1024 * 1024) }),
      ).rejects.toThrow(/too large when unpacked/);
      await expect(
        previewBudgetImport(ctx, { fileName: 'x.xlsx', bytes: Buffer.from('nope') }),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'unreadable_file' });
      expect(await tokens(ctx)).toHaveLength(0);
    });
  });

  describe('commitBudgetImport', () => {
    it('creates the accounts, groups, categories, budget, lines and subscriptions of the sheet', async () => {
      const ctx = await t.household({ locale: 'en' });
      await ensureHouseholdDefaults(ctx);
      const { result } = await importAll(ctx, { emergencyMonths: 9 });

      const accounts = await listAccounts(ctx);
      const byName = new Map(accounts.map((a) => [a.name, a]));
      expect([...byName.keys()].sort()).toEqual(['Cartão A', 'Conta Poupança', 'Conta Principal']);
      expect([...byName.values()].every((a) => a.type === 'other')).toBe(true);

      const groups = await listCategories(ctx);
      const group = (name: string) => groups.find((g) => g.name === name)!;
      expect(group('Habitação').kind).toBe('expense');
      expect(group('Alimentação').categories.map((c) => c.name)).toEqual(['Supermercado']);
      expect(group('Lazer').categories.map((c) => c.name)).toEqual(['Cinema']);
      expect(group('Other')).toMatchObject({ kind: 'expense' });
      expect(group('Other').categories.map((c) => c.name)).toEqual(['Diversos']);
      // Income and saving categories go into the household's own income and saving groups.
      const income = groups.find((g) => g.templateKey === 'income')!;
      expect(income.categories.map((c) => c.name)).toEqual(
        expect.arrayContaining(['Salário A', 'Salário B']),
      );
      const savings = groups.find((g) => g.templateKey === 'savings')!;
      expect(savings.categories.map((c) => c.name)).toContain('Fundo de emergência');

      const detail = await getBudget(ctx, result.budgetId);
      expect(detail).toMatchObject({ name: 'Budget 2026/27', startMonth: '2026-10-01' });
      expect(detail.lines.map((l) => [l.kind, l.name, l.amounts, l.categoryIds.length])).toEqual([
        ['income', 'Salário A', flat(200_000), 1],
        ['income', 'Salário B', flat(150_000), 1],
        ['expense', 'Renda', flat(60_000), 1],
        ['expense', 'Supermercado', [...flat(40_000).slice(0, 11), 0], 1],
        ['expense', 'Cinema', [5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0], 1],
        ['expense', 'Diversos', flat(2_000), 1],
        ['saving', 'Fundo de emergência', flat(20_000), 1],
      ]);
      const line = (name: string) => detail.lines.find((l) => l.name === name)!;
      expect(line('Renda')).toMatchObject({
        groupId: group('Habitação').id,
        accountId: byName.get('Conta Principal')!.id,
      });
      expect(line('Cinema').accountId).toBeNull();
      expect(line('Salário A').groupId).toBeNull();
      expect(line('Diversos').groupId).toBe(group('Other').id);
      expect(line('Renda').categoryIds).toEqual([
        group('Habitação').categories.find((c) => c.name === 'Renda')!.id,
      ]);

      const [settings] = await inHousehold(ctx, (tx) =>
        tx
          .select()
          .from(householdSettings)
          .where(eq(householdSettings.householdId, ctx.householdId)),
      );
      expect(settings!.emergencyFundMonths).toBe(9);

      expect(result).toMatchObject({
        accountsCreated: 3,
        groupsCreated: 4,
        linesImported: 7,
        subscriptionsImported: 4,
        subscriptionsSkipped: 1,
      });
    });

    it('imports subscriptions as confirmed outgoing recurring rows from the sheet', async () => {
      const ctx = await t.household();
      await importAll(ctx);
      const rows = await importRows(ctx);
      const accounts = new Map((await listAccounts(ctx)).map((a) => [a.name, a.id]));
      expect(
        rows
          .map((r) => [r.name, r.amount, r.cadence, r.status, r.source, r.accountId, r.currency])
          .sort(),
      ).toEqual(
        [
          [
            'Streaming A',
            -1_200,
            'monthly',
            'confirmed',
            'import',
            accounts.get('Cartão A'),
            'EUR',
          ],
          [
            'Seguro B',
            -24_000,
            'yearly',
            'confirmed',
            'import',
            accounts.get('Conta Principal'),
            'EUR',
          ],
          [
            'Ginásio C',
            -9_000,
            'quarterly',
            'confirmed',
            'import',
            accounts.get('Cartão A'),
            'EUR',
          ],
          ['Revista D', -500, 'weekly', 'confirmed', 'import', null, 'EUR'],
        ].sort(),
      );
    });

    it('keys imported subscriptions like declared ones, so they adopt payments, and re-import keeps the rows', async () => {
      const ctx = await t.household();
      await importAll(ctx);
      const key = `d:${normalizeDescription('Streaming A')}`;
      const before = await importRows(ctx);
      expect(before.map((r) => r.merchantKey)).toContain(key);

      const card = (await listAccounts(ctx)).find((a) => a.name === 'Cartão A')!;
      await inHousehold(ctx, (tx) =>
        tx.insert(transaction).values({
          householdId: ctx.householdId,
          accountId: card.id,
          dedupeHash: 'sub-pay-1',
          bookingDate: '2026-06-05',
          amount: -1_200,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'DD STREAMING A 99',
          counterparty: 'Streaming A',
          source: 'manual',
        }),
      );
      await runRecurringDetection(
        { db: ctx.db, now: new Date('2026-06-10T12:00:00Z') },
        ctx.householdId,
      );
      const adopted = (await importRows(ctx)).find((r) => r.merchantKey === key)!;
      expect(adopted).toMatchObject({ lastSeenOn: '2026-06-05', nextExpectedOn: '2026-07-05' });

      await importAll(ctx, undefined, { ...ALL, replaceExisting: true });
      const after = await importRows(ctx);
      expect(after).toHaveLength(before.length);
      expect(after.find((r) => r.merchantKey === key)!.id).toBe(adopted.id);
    });

    it('updates a row stored under the legacy i: key instead of duplicating it', async () => {
      const ctx = await t.household();
      await importAll(ctx);
      const key = `d:${normalizeDescription('Streaming A')}`;
      await inHousehold(ctx, (tx) =>
        tx
          .update(recurring)
          .set({ merchantKey: `i:${normalizeDescription('Streaming A')}` })
          .where(eq(recurring.merchantKey, key)),
      );
      const legacy = (await importRows(ctx)).find((r) => r.name === 'Streaming A')!;
      await importAll(ctx, undefined, { ...ALL, replaceExisting: true });
      const rows = await importRows(ctx);
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.name === 'Streaming A')).toMatchObject({
        id: legacy.id,
        merchantKey: key,
      });
    });

    it('names the budget in English for an English household and uses Other', async () => {
      const ctx = await t.household({ locale: 'en' });
      const { result } = await importAll(ctx);
      expect((await getBudget(ctx, result.budgetId)).name).toBe('Budget 2026/27');
      expect((await listCategories(ctx)).map((g) => g.name)).toContain('Other');
    });

    it('reuses existing accounts, groups, income groups and categories instead of duplicating', async () => {
      const ctx = await t.household({ locale: 'en' });
      await ensureHouseholdDefaults(ctx);
      const main = await createAccount(ctx, { name: 'conta principal', type: 'checking' });
      const housing = await createCategoryGroup(ctx, { name: 'Habitação', kind: 'expense' });
      const rent = await createCategory(ctx, { groupId: housing.id, name: 'Renda' });
      const before = await footprint(ctx);

      const { result } = await importAll(ctx);
      const after = await footprint(ctx);
      expect(after.accounts - before.accounts).toBe(2);
      expect((await listAccounts(ctx)).filter((a) => a.id === main.id)).toHaveLength(1);
      const housingNow = (await listCategories(ctx)).find((g) => g.id === housing.id)!;
      expect(housingNow.categories.map((c) => c.id)).toEqual([rent.id]);
      const detail = await getBudget(ctx, result.budgetId);
      expect(detail.lines.find((l) => l.name === 'Renda')!.categoryIds).toEqual([rent.id]);
      // Alimentação, Lazer and Other are new; Habitação existed.
      expect(result.groupsCreated).toBe(3);
    });

    it('reuses the one same-named category of a compatible kind found anywhere in the household', async () => {
      const ctx = await t.household({ locale: 'en' });
      await ensureHouseholdDefaults(ctx);
      const home = await createCategoryGroup(ctx, { name: 'Casa', kind: 'expense' });
      const rent = await createCategory(ctx, { groupId: home.id, name: 'renda' });
      // Cinema exists only as an income category: not compatible with an expense line.
      const incomeGroup = (await listCategories(ctx)).find((g) => g.templateKey === 'income')!;
      await createCategory(ctx, { groupId: incomeGroup.id, name: 'Cinema' });

      const { result } = await importAll(ctx);
      const groups = await listCategories(ctx);
      const named = (name: string) =>
        groups.flatMap((g) => g.categories.filter((c) => c.name.toLowerCase() === name));
      expect(named('renda').map((c) => c.id)).toEqual([rent.id]);
      const detail = await getBudget(ctx, result.budgetId);
      expect(detail.lines.find((l) => l.name === 'Renda')!.categoryIds).toEqual([rent.id]);
      // Cinema was created in its own group, beside the income one.
      expect(named('cinema')).toHaveLength(2);
      expect(result.categoriesCreated).toBe(6);
    });

    it('creates in the group when the household has two same-named categories or an archived one', async () => {
      const ctx = await t.household({ locale: 'en' });
      await ensureHouseholdDefaults(ctx);
      const a = await createCategoryGroup(ctx, { name: 'A', kind: 'expense' });
      const b = await createCategoryGroup(ctx, { name: 'B', kind: 'expense' });
      await createCategory(ctx, { groupId: a.id, name: 'Renda' });
      await createCategory(ctx, { groupId: b.id, name: 'Renda' });
      const old = await createCategory(ctx, { groupId: a.id, name: 'Cinema' });
      await archiveCategory(ctx, old.id);

      const { result } = await importAll(ctx);
      const groups = await listCategories(ctx);
      const habitacao = groups.find((g) => g.name === 'Habitação')!;
      expect(habitacao.categories.map((c) => c.name)).toEqual(['Renda']);
      const lazer = groups.find((g) => g.name === 'Lazer')!;
      expect(lazer.categories.map((c) => c.name)).toEqual(['Cinema']);
      expect(result.categoriesCreated).toBe(7);
    });

    it.each([
      ['pt-PT', 'Receitas', 'Poupança'],
      ['en', 'Income', 'Savings'],
    ])(
      'creates income and saving groups in the household locale (%s) when it has none',
      async (locale, income, saving) => {
        const ctx = await t.household({ locale });
        await importAll(ctx);
        const groups = await listCategories(ctx);
        expect(groups.find((g) => g.name === income)).toMatchObject({ kind: 'income' });
        expect(groups.find((g) => g.name === saving)).toMatchObject({ kind: 'saving' });
      },
    );

    it.each([
      ['pt-PT', 'Orçamento 2027'],
      ['en', 'Budget 2027'],
    ])('names a budget starting in January by its year only (%s)', async (locale, name) => {
      const ctx = await t.household({ locale });
      const { result, preview } = await importAll(ctx, { startDate: '01/01/2027' });
      expect(preview.budgetName).toBe(name);
      expect((await getBudget(ctx, result.budgetId)).name).toBe(name);
    });

    it('imports a workbook whose amounts are numbers', async () => {
      const ctx = await t.household();
      const { result } = await importAll(ctx, { numericAmounts: true });
      const detail = await getBudget(ctx, result.budgetId);
      expect(detail.lines.find((l) => l.name === 'Renda')!.amounts).toEqual(flat(60_000));
      expect((await importRows(ctx)).map((r) => r.amount).sort((a, b) => a - b)).toEqual([
        -24_000, -9_000, -1_200, -500,
      ]);
    });

    it('leaves unmatched accounts and groups out when told not to create them', async () => {
      const ctx = await t.household({ locale: 'pt-PT' });
      const main = await createAccount(ctx, { name: 'Conta Principal', type: 'checking' });
      const { result } = await importAll(ctx, undefined, {
        createMissingAccounts: false,
        createMissingGroups: false,
        replaceExisting: false,
      });
      expect((await listAccounts(ctx)).map((a) => a.name)).toEqual(['Conta Principal']);
      const groups = await listCategories(ctx);
      expect(groups.map((g) => g.name).sort()).toEqual(['Outros', 'Poupança', 'Receitas']);
      const detail = await getBudget(ctx, result.budgetId);
      const others = groups.find((g) => g.name === 'Outros')!;
      const renda = detail.lines.find((l) => l.name === 'Renda')!;
      expect(renda.accountId).toBe(main.id);
      expect(renda.groupId).toBe(others.id);
      expect(others.categories.map((c) => c.name).sort()).toEqual([
        'Cinema',
        'Diversos',
        'Renda',
        'Supermercado',
      ]);
      expect(detail.lines.find((l) => l.name === 'Supermercado')!.accountId).toBeNull();
      expect(result).toMatchObject({ accountsCreated: 0 });
    });

    it('refuses an existing budget without replaceExisting and writes nothing', async () => {
      const ctx = await t.household();
      await importAll(ctx);
      const before = await footprint(ctx);
      const preview = await previewBudgetImport(ctx, await file({ emergencyMonths: 3 }));
      const error = await commitBudgetImport(ctx, preview.token, ALL).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('budget_exists');
      expect(await footprint(ctx)).toEqual({ ...before });
      const [settings] = await inHousehold(ctx, (tx) =>
        tx
          .select()
          .from(householdSettings)
          .where(eq(householdSettings.householdId, ctx.householdId)),
      );
      expect(settings!.emergencyFundMonths).toBe(6);
      // The token is still good: the user can confirm the replacement.
      await expect(
        commitBudgetImport(ctx, preview.token, { ...ALL, replaceExisting: true }),
      ).resolves.toMatchObject({ linesImported: 7 });
    });

    it('replaces the lines of the existing budget, keeps its id and never touches transactions', async () => {
      const ctx = await t.household();
      const first = await importAll(ctx);
      const account = (await listAccounts(ctx))[0]!;
      const rentCategory = (await listCategories(ctx))
        .flatMap((g) => g.categories)
        .find((c) => c.name === 'Renda')!;
      await upsertBudgetLine(ctx, first.result.budgetId, { kind: 'expense', name: 'Antiga' });
      await inHousehold(ctx, (tx) =>
        tx.insert(transaction).values({
          householdId: ctx.householdId,
          accountId: account.id,
          dedupeHash: 'budget-import-tx',
          bookingDate: '2026-10-05',
          amount: -60_000,
          currency: 'EUR',
          status: 'booked',
          rawDescription: 'RENDA',
          categoryId: rentCategory.id,
          source: 'manual',
        }),
      );
      const before = await footprint(ctx);

      const second = await importAll(
        ctx,
        { monthHeaders: 'date' },
        { ...ALL, replaceExisting: true },
      );
      expect(second.result.budgetId).toBe(first.result.budgetId);
      const detail = await getBudget(ctx, second.result.budgetId);
      expect(detail.lines.map((l) => l.name)).not.toContain('Antiga');
      expect(detail.lines).toHaveLength(7);
      // Idempotent: nothing new is created by importing the same year again.
      expect(await footprint(ctx)).toEqual(before);
      const rows = await inHousehold(ctx, (tx) =>
        tx.select().from(transaction).where(eq(transaction.householdId, ctx.householdId)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ categoryId: rentCategory.id, amount: -60_000 });
    });

    it('imports another budget year next to the first', async () => {
      const ctx = await t.household();
      await importAll(ctx);
      await importAll(ctx, { startDate: '01/10/2027' });
      expect((await listBudgets(ctx)).map((b) => b.startMonth)).toEqual([
        '2027-10-01',
        '2026-10-01',
      ]);
    });

    it('spends the token once, and only for its owner, unexpired', async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(ctx, await file());
      const stranger = { ...ctx, userId: 'user-2' };
      await expect(commitBudgetImport(stranger, preview.token, ALL)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const other = await t.household();
      await expect(commitBudgetImport(other, preview.token, ALL)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(commitBudgetImport(ctx, 'not-a-token', ALL)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await commitBudgetImport(ctx, preview.token, ALL);
      await expect(
        commitBudgetImport(ctx, preview.token, { ...ALL, replaceExisting: true }),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'preview_used' });

      const stale = await previewBudgetImport(ctx, await file({ startDate: '01/10/2030' }));
      await t.owner
        .update(undoToken)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(undoToken.id, stale.token));
      await expect(commitBudgetImport(ctx, stale.token, ALL)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'preview_expired',
      });
    });

    it("does not tell another user's or an unknown token from a missing one", async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(ctx, await file());
      await t.owner
        .update(undoToken)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(undoToken.id, preview.token));
      const stranger = { ...ctx, userId: 'someone-else' };
      await expect(commitBudgetImport(stranger, preview.token, ALL)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('holds the token for 30 minutes', async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(ctx, await file());
      const [row] = await t.owner.select().from(undoToken).where(eq(undoToken.id, preview.token));
      const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 5_000);
      expect(preview.expiresAt).toBe(row!.expiresAt.toISOString());
    });

    it('refuses viewers and invalid choices', async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(ctx, await file());
      await expect(
        commitBudgetImport(withRole(ctx, 'viewer'), preview.token, ALL),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        commitBudgetImport(ctx, preview.token, { createMissingAccounts: true } as never),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('writes nothing when the commit fails half way', async () => {
      const ctx = await t.household();
      const preview = await previewBudgetImport(ctx, await file());
      // The stored preview is altered behind the service's back so that a late line is invalid:
      // the accounts, groups and budget before it were already written inside the transaction.
      const [row] = await t.owner.select().from(undoToken).where(eq(undoToken.id, preview.token));
      const payload = structuredClone(row!.payload) as {
        sheet: { lines: Array<{ name: string }> };
      };
      payload.sheet.lines.at(-1)!.name = 'x'.repeat(200);
      await t.owner.update(undoToken).set({ payload }).where(eq(undoToken.id, preview.token));
      const before = await footprint(ctx);

      await expect(commitBudgetImport(ctx, preview.token, ALL)).rejects.toThrow(ValidationError);
      expect(await footprint(ctx)).toEqual(before);
      const [again] = await tokens(ctx);
      expect(again!.usedAt).toBeNull();
      const [stored] = await t.owner
        .select({ n: budget.id })
        .from(budget)
        .where(and(eq(budget.householdId, ctx.householdId)));
      expect(stored).toBeUndefined();
    });
  });
});
