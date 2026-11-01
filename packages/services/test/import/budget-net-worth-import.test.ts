import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  commitBudgetImport,
  createAccount,
  archiveGoal,
  createAsset,
  createGoal,
  listBudgets,
  listGoals,
  netWorthAt,
  snapshotNetWorth,
  NotFoundError,
  previewBudgetImport,
  ValidationError,
  type BudgetImportChoices,
  type ServiceCtx,
} from '../../src/index.js';
import { buildBudgetSheet, type BudgetSheetOptions } from '../fixtures/budget-sheet.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';

const {
  asset,
  assetValuation,
  liability,
  liabilityBalance,
  goal,
  budgetLine,
  undoToken,
  category,
  transaction,
  netWorthSnapshot,
} = schema;

const ALL: BudgetImportChoices = {
  createMissingAccounts: true,
  createMissingGroups: true,
  replaceExisting: false,
};
const AGAIN: BudgetImportChoices = { ...ALL, replaceExisting: true };
const EMERGENCY = {
  name: 'Fundo de Emergência',
  target: 1_200_000,
  saved: 700_000,
  contribution: 20_000,
};
/** After every month of the fixture, so none is a projection. */
const NOW = new Date('2027-12-31T12:00:00Z');
const MONTH_ENDS = [
  '2026-10-31',
  '2026-11-30',
  '2026-12-31',
  '2027-01-31',
  '2027-02-28',
  '2027-03-31',
  '2027-04-30',
  '2027-05-31',
  '2027-06-30',
  '2027-07-31',
  '2027-08-31',
  '2027-09-30',
];

describe('net worth and goals spreadsheet import', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const file = async (opts?: BudgetSheetOptions) => ({
    fileName: 'orcamento.xlsx',
    bytes: await buildBudgetSheet(opts),
  });
  const inHousehold = <T>(ctx: ServiceCtx, fn: Parameters<typeof withHousehold<T>>[2]) =>
    withHousehold(ctx.db, ctx.householdId, fn);
  const previewAt = (ctx: ServiceCtx, f: Awaited<ReturnType<typeof file>>, now = NOW) =>
    previewBudgetImport(ctx, f, { now });
  const commitAt = (ctx: ServiceCtx, token: string, choices: BudgetImportChoices, now = NOW) =>
    commitBudgetImport(ctx, token, choices, { now });
  async function run(
    ctx: ServiceCtx,
    opts?: BudgetSheetOptions,
    choices: BudgetImportChoices = ALL,
  ) {
    const previewed = await previewAt(ctx, await file(opts));
    const result = await commitAt(ctx, previewed.token, choices);
    return { preview: previewed, result };
  }
  const rows = (ctx: ServiceCtx) =>
    inHousehold(ctx, async (tx) => ({
      assets: await tx.select().from(asset).where(eq(asset.householdId, ctx.householdId)),
      liabilities: await tx
        .select()
        .from(liability)
        .where(eq(liability.householdId, ctx.householdId)),
      goals: await tx.select().from(goal).where(eq(goal.householdId, ctx.householdId)),
      valuations: await tx
        .select()
        .from(assetValuation)
        .where(eq(assetValuation.householdId, ctx.householdId)),
      balances: await tx
        .select()
        .from(liabilityBalance)
        .where(eq(liabilityBalance.householdId, ctx.householdId)),
    }));
  const named = <T extends { name: string }>(list: T[], name: string) =>
    list.find((r) => r.name === name)!;

  describe('preview', () => {
    it('lists the assets, credits and goals with account suggestions and existing matches', async () => {
      const ctx = await t.household();
      const cash = await createAccount(ctx, { name: ' CONTAS a ordem', type: 'checking' });
      const preview = await previewAt(ctx, await file({ extraGoals: [EMERGENCY] }));

      expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
      expect(preview.patrimonio!.assets.map((a) => [a.name, a.kind, a.suggestedAccountId])).toEqual(
        [
          ['Casa', 'real_estate', null],
          ['Carro', 'vehicle', null],
          ['Trading Teste', 'investment', null],
          ['Contas à ordem', 'cash', cash.id],
        ],
      );
      expect(preview.patrimonio!.assets[0]!.values).toHaveLength(12);
      // Row keys come from the service, so callers never rebuild them (accent- and case-insensitive).
      expect(preview.patrimonio!.assets.map((a) => a.linkKey)).toEqual([
        'asset:casa',
        'asset:carro',
        'asset:trading teste',
        'asset:contas a ordem',
      ]);
      expect(preview.patrimonio!.liabilities.map((l) => l.linkKey)).toEqual([
        'liability:hipoteca casa',
        'liability:emprestimo auto',
      ]);
      // The default sheet's only saving line is "Fundo de emergência": the goal of that name links.
      expect(preview.goals!.map((g) => [g.name, g.lineMatch])).toEqual([
        ['Férias', false],
        ['Viagem', false],
        ['Fundo de Emergência', true],
      ]);
      expect(preview.patrimonio!.liabilities.map((l) => [l.name, l.kind])).toEqual([
        ['Hipoteca Casa', 'mortgage'],
        ['Empréstimo Auto', 'loan'],
      ]);
      expect(preview.goals!.map((g) => [g.name, g.kind, g.match])).toEqual([
        ['Férias', 'generic', null],
        ['Viagem', 'generic', null],
        ['Fundo de Emergência', 'emergency_fund', null],
      ]);
      expect(preview.warnings).toEqual([
        { code: 'derived_target', params: { name: 'Fundo de Emergência' } },
      ]);
      expect((await rows(ctx)).assets).toEqual([]);
    });

    it('shows the existing record a row would update', async () => {
      const ctx = await t.household();
      await run(ctx);
      const preview = await previewAt(ctx, await file());
      const { assets, goals } = await rows(ctx);
      expect(named(preview.patrimonio!.assets, 'Casa').match).toBe(named(assets, 'Casa').id);
      expect(named(preview.goals!, 'Viagem').match).toBe(named(goals, 'Viagem').id);
    });

    it('has no net worth sections when the workbook lacks the sheets', async () => {
      const ctx = await t.household();
      const preview = await previewAt(ctx, await file({ omitSheets: ['Património', 'Objetivos'] }));
      expect(preview.patrimonio).toBeNull();
      expect(preview.goals).toBeNull();
    });
  });

  describe('commit', () => {
    it('creates assets and credits with their kinds and import-sourced monthly values', async () => {
      const ctx = await t.household({ currency: 'EUR' });
      const { result } = await run(ctx);
      const { assets, liabilities, valuations, balances } = await rows(ctx);

      expect(result).toMatchObject({
        assetsCreated: 4,
        assetsUpdated: 0,
        liabilitiesCreated: 2,
        liabilitiesUpdated: 0,
      });
      expect(assets.map((a) => [a.name, a.kind, a.currency, a.accountId, a.position])).toEqual(
        expect.arrayContaining([
          ['Casa', 'real_estate', 'EUR', null, 0],
          ['Carro', 'vehicle', 'EUR', null, 1],
          ['Trading Teste', 'investment', 'EUR', null, 2],
          ['Contas à ordem', 'cash', 'EUR', null, 3],
        ]),
      );
      expect(named(assets, 'Casa').notes).toBe('Valor de mercado');
      expect(liabilities.map((l) => [l.name, l.kind])).toEqual(
        expect.arrayContaining([
          ['Hipoteca Casa', 'mortgage'],
          ['Empréstimo Auto', 'loan'],
        ]),
      );
      const house = valuations
        .filter((v) => v.assetId === named(assets, 'Casa').id)
        .sort((a, b) => a.asOf.localeCompare(b.asOf));
      expect(house.map((v) => v.asOf)).toEqual(MONTH_ENDS);
      expect(house.every((v) => v.value === 15_000_000 && v.method === 'import')).toBe(true);
      // Blank months write nothing; "-" and 0 are written as zero.
      const trading = valuations.filter((v) => v.assetId === named(assets, 'Trading Teste').id);
      expect(trading).toHaveLength(8);
      expect(trading.find((v) => v.asOf === '2027-01-31')!.value).toBe(0);
      const mortgage = balances.filter(
        (b) => b.liabilityId === named(liabilities, 'Hipoteca Casa').id,
      );
      expect(mortgage).toHaveLength(12);
      expect(mortgage.every((b) => b.source === 'import')).toBe(true);
      expect(mortgage.find((b) => b.asOf === '2026-10-31')!.balance).toBe(10_000_000);
    });

    it('links a row to the account it matches by default and then writes no values for it', async () => {
      const ctx = await t.household();
      const cash = await createAccount(ctx, { name: 'contas a ordem', type: 'checking' });
      await run(ctx);
      const { assets, valuations } = await rows(ctx);
      const linked = named(assets, 'Contas à ordem');
      expect(linked).toMatchObject({ kind: 'cash', accountId: cash.id });
      expect(valuations.filter((v) => v.assetId === linked.id)).toEqual([]);
      expect(valuations.filter((v) => v.assetId === named(assets, 'Casa').id)).toHaveLength(12);
    });

    it('does not link a row whose choice is null, and links another to a chosen account', async () => {
      const ctx = await t.household();
      await createAccount(ctx, { name: 'Contas à ordem', type: 'checking' });
      const other = await createAccount(ctx, { name: 'Outra', type: 'savings' });
      await run(ctx, undefined, {
        ...ALL,
        accountLinks: { 'asset:contas a ordem': null, 'asset:casa': other.id },
      });
      const { assets, valuations } = await rows(ctx);
      const cashRow = named(assets, 'Contas à ordem');
      expect(cashRow.accountId).toBeNull();
      expect(valuations.filter((v) => v.assetId === cashRow.id)).toHaveLength(12);
      const house = named(assets, 'Casa');
      expect(house.accountId).toBe(other.id);
      expect(valuations.filter((v) => v.assetId === house.id)).toEqual([]);
    });

    it('links a credit to a loan account like an asset', async () => {
      const ctx = await t.household();
      const loan = await createAccount(ctx, { name: 'Hipoteca casa', type: 'loan' });
      await run(ctx);
      const { liabilities, balances } = await rows(ctx);
      const mortgage = named(liabilities, 'Hipoteca Casa');
      expect(mortgage).toMatchObject({ kind: 'mortgage', accountId: loan.id });
      expect(balances.filter((b) => b.liabilityId === mortgage.id)).toEqual([]);
    });

    it('refuses a link to an account of another household or a key the sheet lacks', async () => {
      const ctx = await t.household();
      const stranger = await t.household();
      const foreign = await createAccount(stranger, { name: 'X', type: 'checking' });
      const preview = await previewAt(ctx, await file());
      await expect(
        commitAt(ctx, preview.token, {
          ...ALL,
          accountLinks: { 'asset:casa': foreign.id },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        commitAt(ctx, preview.token, { ...ALL, accountLinks: { 'asset:nada': null } }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await rows(ctx)).assets).toEqual([]);
      expect(await listBudgets(ctx)).toEqual([]);
    });

    it('creates goals and links them to the saving line of the same name', async () => {
      const ctx = await t.household();
      const { result } = await run(ctx, { extraGoals: [EMERGENCY] });
      const { goals } = await rows(ctx);
      const lines = await inHousehold(ctx, (tx) =>
        tx.select().from(budgetLine).where(eq(budgetLine.householdId, ctx.householdId)),
      );
      const savingLine = lines.find((l) => l.kind === 'saving')!;

      expect(result).toMatchObject({ goalsCreated: 3, goalsUpdated: 0 });
      expect(named(goals, 'Férias')).toMatchObject({
        kind: 'generic',
        targetAmount: null,
        monthlyContribution: 10_000,
        budgetLineId: null,
        accountId: null,
      });
      expect(named(goals, 'Viagem')).toMatchObject({ targetAmount: 300_000, budgetLineId: null });
      expect(named(goals, 'Fundo de Emergência')).toMatchObject({
        kind: 'emergency_fund',
        targetAmount: null,
        monthlyContribution: 20_000,
        budgetLineId: savingLine.id,
      });
    });

    it('stores Saldo atual as the already-saved baseline, dated the import date', async () => {
      const ctx = await t.household();
      const carro = { name: 'Carro novo', target: 900_000, saved: 100_000, contribution: 3_000 };
      const { preview, result } = await run(ctx, { extraGoals: [EMERGENCY, carro] });
      const { goals } = await rows(ctx);
      expect(named(goals, 'Fundo de Emergência')).toMatchObject({
        savedBaseline: 700_000,
        savedBaselineDate: '2027-12-31',
      });
      expect(named(goals, 'Carro novo')).toMatchObject({
        budgetLineId: null,
        savedBaseline: 100_000,
        savedBaselineDate: '2027-12-31',
      });
      // a zero Saldo atual stores nothing
      expect(named(goals, 'Viagem')).toMatchObject({
        savedBaseline: null,
        savedBaselineDate: null,
      });
      // nothing was ignored
      for (const w of [...preview.warnings, ...result.warnings]) {
        expect(w.code).not.toBe('saved_ignored');
      }
      const saved = new Map((await listGoals(ctx, { now: NOW })).map((g) => [g.name, g.saved]));
      expect(saved.get('Carro novo')).toBe(100_000);
      expect(saved.get('Fundo de Emergência')).toBe(700_000);
    });

    it('warns saved_ignored only for a goal linked to an account, and stores nothing for it', async () => {
      const ctx = await t.household();
      const acc = await createAccount(ctx, { name: 'Pote', type: 'savings' });
      await createGoal(ctx, { name: 'Viagem', accountId: acc.id });
      const { preview, result } = await run(ctx, {
        patchGoals: [{ row: 4, col: 'C', value: '500,00 €' }],
      });
      const ignored = { code: 'saved_ignored', params: { name: 'Viagem', amount: 50_000 } };
      expect(preview.warnings).toContainEqual(ignored);
      expect(result.warnings).toContainEqual(ignored);
      expect(named((await rows(ctx)).goals, 'Viagem')).toMatchObject({
        accountId: acc.id,
        savedBaseline: null,
      });
    });

    it('keeps the savings the app tracked since the last import and warns saved_differs', async () => {
      const ctx = await t.household();
      const october = new Date('2026-10-19T12:00:00Z');
      const december = new Date('2026-12-10T12:00:00Z');
      const sheet = { extraGoals: [{ ...EMERGENCY, saved: 180_000 }] };
      const first = await previewAt(ctx, await file(sheet), october);
      await commitAt(ctx, first.token, ALL, october);
      expect(named((await rows(ctx)).goals, 'Fundo de Emergência')).toMatchObject({
        savedBaseline: 180_000,
        savedBaselineDate: '2026-10-19',
      });
      // 200 € put aside on the fund's line in November
      const [cat] = await inHousehold(ctx, (tx) =>
        tx.select().from(category).where(eq(category.name, 'Fundo de emergência')),
      );
      const [acc] = await inHousehold(ctx, (tx) =>
        tx.select().from(schema.financialAccount).limit(1),
      );
      await t.owner.insert(transaction).values({
        householdId: ctx.householdId,
        accountId: acc!.id,
        dedupeHash: 'reimport-progress',
        bookingDate: '2026-11-10',
        amount: -20_000,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'x',
        source: 'manual',
        categoryId: cat!.id,
      });
      const savedOf = async (now: Date) =>
        (await listGoals(ctx, { now })).find((g) => g.name === 'Fundo de Emergência')!.saved;
      expect(await savedOf(december)).toBe(200_000);

      const again = await previewAt(ctx, await file(sheet), december);
      const result = await commitAt(ctx, again.token, AGAIN, december);
      const differs = {
        code: 'saved_differs',
        params: { name: 'Fundo de Emergência', sheet: 180_000, app: 200_000 },
      };
      expect(again.warnings).toContainEqual(differs);
      expect(result.warnings).toContainEqual(differs);
      expect(named((await rows(ctx)).goals, 'Fundo de Emergência')).toMatchObject({
        savedBaseline: 180_000,
        savedBaselineDate: '2026-10-19',
      });
      expect(await savedOf(december)).toBe(200_000);
    });

    it('gives a matched goal with no baseline, no line and no account the sheet value', async () => {
      const ctx = await t.household();
      const mine = await createGoal(ctx, { name: 'Carro novo' });
      const carro = { name: 'Carro novo', target: 900_000, saved: 100_000, contribution: 3_000 };
      const { preview, result } = await run(ctx, { extraGoals: [carro] });
      expect(named((await rows(ctx)).goals, 'Carro novo')).toMatchObject({
        id: mine.id,
        savedBaseline: 100_000,
        savedBaselineDate: '2027-12-31',
      });
      for (const w of [...preview.warnings, ...result.warnings]) {
        expect(w.code).not.toBe('saved_differs');
      }
    });

    it('keeps the baseline of a matched goal that has one, even when the sheet says otherwise', async () => {
      const ctx = await t.household();
      await createGoal(ctx, {
        name: 'Carro novo',
        savedBaseline: 40_000,
        savedBaselineDate: '2027-06-01',
      });
      const carro = { name: 'Carro novo', target: 900_000, saved: 100_000, contribution: 3_000 };
      const { preview, result } = await run(ctx, { extraGoals: [carro] });
      expect(named((await rows(ctx)).goals, 'Carro novo')).toMatchObject({
        savedBaseline: 40_000,
        savedBaselineDate: '2027-06-01',
      });
      const differs = {
        code: 'saved_differs',
        params: { name: 'Carro novo', sheet: 100_000, app: 40_000 },
      };
      expect(preview.warnings).toContainEqual(differs);
      expect(result.warnings).toContainEqual(differs);
    });

    it('updates the existing emergency fund, whatever it is called, instead of adding a second one', async () => {
      const ctx = await t.household();
      const mine = await createGoal(ctx, { kind: 'emergency_fund', name: 'Minha reserva' });
      const preview = await previewAt(ctx, await file({ extraGoals: [EMERGENCY] }));
      expect(preview.goals!.find((g) => g.kind === 'emergency_fund')!.match).toBe(mine.id);

      const result = await commitAt(ctx, preview.token, ALL);
      const funds = (await rows(ctx)).goals.filter((g) => g.kind === 'emergency_fund');
      expect(result).toMatchObject({ goalsCreated: 2, goalsUpdated: 1 });
      expect(funds).toHaveLength(1);
      expect(funds[0]).toMatchObject({
        id: mine.id,
        name: 'Minha reserva',
        monthlyContribution: 20_000,
      });
    });

    it('creates the emergency fund again once the old one is archived', async () => {
      const ctx = await t.household();
      const old = await createGoal(ctx, { kind: 'emergency_fund', name: 'Fundo de Emergência' });
      await archiveGoal(ctx, old.id);
      const { result } = await run(ctx, { extraGoals: [EMERGENCY] });
      const funds = (await rows(ctx)).goals.filter((g) => g.kind === 'emergency_fund');
      expect(result).toMatchObject({ goalsCreated: 3, goalsUpdated: 0 });
      expect(funds.map((g) => g.archived).sort()).toEqual([false, true]);
    });

    it('skips a section the user excludes, and does so for sheets that are absent without error', async () => {
      const ctx = await t.household();
      await run(ctx, undefined, { ...ALL, includePatrimonio: false });
      let now = await rows(ctx);
      expect([now.assets.length, now.liabilities.length, now.goals.length]).toEqual([0, 0, 2]);

      const ctx2 = await t.household();
      await run(ctx2, undefined, { ...ALL, includeObjetivos: false });
      now = await rows(ctx2);
      expect([now.assets.length, now.goals.length]).toEqual([4, 0]);

      const ctx3 = await t.household();
      const { result } = await run(ctx3, { omitSheets: ['Património', 'Objetivos'] });
      now = await rows(ctx3);
      expect([now.assets.length, now.goals.length]).toEqual([0, 0]);
      expect(result).toMatchObject({ assetsCreated: 0, goalsCreated: 0 });
    });

    it('stores number cells exactly (12.125 is 12,12 €)', async () => {
      const ctx = await t.household();
      await run(ctx, { patchNetWorth: [{ row: 4, col: 'D', value: 12.125 }] });
      const { assets, valuations } = await rows(ctx);
      const first = valuations.find(
        (v) => v.assetId === named(assets, 'Casa').id && v.asOf === '2026-10-31',
      )!;
      expect(first.value).toBe(1_212);
    });

    it('writes nothing when a goal fails after the budget and the assets were written', async () => {
      const ctx = await t.household();
      const preview = await previewAt(ctx, await file());
      const [row] = await t.owner.select().from(undoToken).where(eq(undoToken.id, preview.token));
      const payload = structuredClone(row!.payload) as {
        sheet: { goals: Array<{ name: string }> };
      };
      payload.sheet.goals.at(-1)!.name = 'x'.repeat(200);
      await t.owner.update(undoToken).set({ payload }).where(eq(undoToken.id, preview.token));

      await expect(commitAt(ctx, preview.token, ALL)).rejects.toBeInstanceOf(ValidationError);
      const now = await rows(ctx);
      expect([now.assets.length, now.liabilities.length, now.goals.length]).toEqual([0, 0, 0]);
      expect(await listBudgets(ctx)).toEqual([]);
    });

    it('still takes the three Phase 3 choices alone, importing every section present', async () => {
      const ctx = await t.household();
      const { result } = await run(ctx);
      expect(result).toMatchObject({ assetsCreated: 4, liabilitiesCreated: 2, goalsCreated: 2 });
    });
  });

  describe('importing the same workbook again', () => {
    it('updates by name instead of duplicating and replaces import-sourced values only', async () => {
      const ctx = await t.household();
      await run(ctx);
      const first = await rows(ctx);
      const house = named(first.assets, 'Casa');
      const mortgage = named(first.liabilities, 'Hipoteca Casa');

      // The user edits some values by hand, in other ways a connector or schedule would.
      await inHousehold(ctx, async (tx) => {
        await tx
          .update(assetValuation)
          .set({ value: 1, method: 'manual' })
          .where(and(eq(assetValuation.assetId, house.id), eq(assetValuation.asOf, '2026-10-31')));
        await tx
          .update(assetValuation)
          .set({ value: 2, method: 'depreciation' })
          .where(and(eq(assetValuation.assetId, house.id), eq(assetValuation.asOf, '2026-11-30')));
        await tx
          .update(liabilityBalance)
          .set({ balance: 3, source: 'schedule' })
          .where(
            and(
              eq(liabilityBalance.liabilityId, mortgage.id),
              eq(liabilityBalance.asOf, '2026-10-31'),
            ),
          );
        await tx
          .update(liabilityBalance)
          .set({ balance: 4, source: 'connector' })
          .where(
            and(
              eq(liabilityBalance.liabilityId, mortgage.id),
              eq(liabilityBalance.asOf, '2026-11-30'),
            ),
          );
        await tx.insert(assetValuation).values({
          householdId: ctx.householdId,
          assetId: house.id,
          asOf: '2027-12-31',
          value: 5,
          method: 'manual',
        });
        await tx
          .update(assetValuation)
          .set({ value: 7 })
          .where(and(eq(assetValuation.assetId, house.id), eq(assetValuation.asOf, '2026-12-31')));
      });

      const { result } = await run(ctx, undefined, AGAIN);
      const second = await rows(ctx);
      expect(result).toMatchObject({
        assetsCreated: 0,
        assetsUpdated: 4,
        liabilitiesCreated: 0,
        liabilitiesUpdated: 2,
        goalsCreated: 0,
        goalsUpdated: 2,
      });
      expect(second.assets.map((a) => a.id).sort()).toEqual(first.assets.map((a) => a.id).sort());
      expect(second.liabilities).toHaveLength(2);
      expect(second.goals.map((g) => g.id).sort()).toEqual(first.goals.map((g) => g.id).sort());

      const at = (assetId: string, asOf: string) =>
        second.valuations.find((v) => v.assetId === assetId && v.asOf === asOf)!;
      expect(at(house.id, '2026-10-31')).toMatchObject({ value: 1, method: 'manual' });
      expect(at(house.id, '2026-11-30')).toMatchObject({ value: 2, method: 'depreciation' });
      expect(at(house.id, '2027-12-31')).toMatchObject({ value: 5, method: 'manual' });
      // An import-sourced value on the same date is replaced by the sheet's.
      expect(at(house.id, '2026-12-31')).toMatchObject({ value: 15_000_000, method: 'import' });
      const bal = (asOf: string) =>
        second.balances.find((b) => b.liabilityId === mortgage.id && b.asOf === asOf)!;
      expect(bal('2026-10-31')).toMatchObject({ balance: 3, source: 'schedule' });
      expect(bal('2026-11-30')).toMatchObject({ balance: 4, source: 'connector' });
      expect(second.valuations).toHaveLength(first.valuations.length + 1);
      expect(second.balances).toHaveLength(first.balances.length);
    });

    it('keeps a goal on the recreated budget line of the same name', async () => {
      const ctx = await t.household();
      await run(ctx);
      const lineOf = async () =>
        (
          await inHousehold(ctx, (tx) =>
            tx.select().from(budgetLine).where(eq(budgetLine.householdId, ctx.householdId)),
          )
        ).find((l) => l.name === 'Fundo de emergência')!;
      // a goal the user linked by hand, not in the sheet's Objetivos
      const mine = await createGoal(ctx, { name: 'Mealheiro', budgetLineId: (await lineOf()).id });
      const { preview, result } = await run(ctx, undefined, AGAIN);
      const relinked = named((await rows(ctx)).goals, 'Mealheiro');
      expect(relinked.id).toBe(mine.id);
      expect(relinked.budgetLineId).toBe((await lineOf()).id);
      for (const w of [...preview.warnings, ...result.warnings]) {
        expect(w.code).not.toBe('goal_unlinked');
      }
    });

    it('warns goal_unlinked when the line is gone, keeping what the goal had saved', async () => {
      const ctx = await t.household();
      await run(ctx);
      const lines = await inHousehold(ctx, (tx) =>
        tx.select().from(budgetLine).where(eq(budgetLine.householdId, ctx.householdId)),
      );
      const line = lines.find((l) => l.name === 'Fundo de emergência')!;
      const mine = await createGoal(ctx, { name: 'Mealheiro', budgetLineId: line.id });
      // 150 € put aside on that line in March 2027
      const [cat] = await inHousehold(ctx, (tx) =>
        tx.select().from(category).where(eq(category.name, 'Fundo de emergência')),
      );
      const [acc] = await inHousehold(ctx, (tx) =>
        tx.select().from(schema.financialAccount).limit(1),
      );
      await t.owner.insert(transaction).values({
        householdId: ctx.householdId,
        accountId: acc!.id,
        dedupeHash: 'goal-unlinked',
        bookingDate: '2027-03-10',
        amount: -15_000,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'x',
        source: 'manual',
        categoryId: cat!.id,
      });
      expect((await listGoals(ctx, { now: NOW })).find((g) => g.id === mine.id)!.saved).toBe(
        15_000,
      );

      const { preview, result } = await run(
        ctx,
        { patchBudget: [{ row: 16, col: 'A', value: 'Reserva' }] },
        AGAIN,
      );
      const unlinked = { code: 'goal_unlinked', params: { name: 'Mealheiro' } };
      expect(preview.warnings).toContainEqual(unlinked);
      expect(result.warnings).toContainEqual(unlinked);
      const after = named((await rows(ctx)).goals, 'Mealheiro');
      expect(after).toMatchObject({ budgetLineId: null, savedBaseline: 15_000 });
      expect((await listGoals(ctx, { now: NOW })).find((g) => g.id === mine.id)!.saved).toBe(
        15_000,
      );
    });

    it('takes new sheet values for import-sourced dates and updates kind, notes and goal fields', async () => {
      const ctx = await t.household();
      await run(ctx);
      await run(
        ctx,
        {
          patchNetWorth: [
            { row: 4, col: 'D', value: '99 000,00 €' },
            { row: 4, col: 'C', value: 'Nova nota' },
          ],
          patchGoals: [
            { row: 4, col: 'B', value: '4 000,00 €' },
            { row: 4, col: 'D', value: '7 000,00 €' },
          ],
        },
        AGAIN,
      );
      const { assets, valuations, goals } = await rows(ctx);
      const house = named(assets, 'Casa');
      expect(house.notes).toBe('Nova nota');
      expect(valuations.find((v) => v.assetId === house.id && v.asOf === '2026-10-31')!.value).toBe(
        9_900_000,
      );
      expect(named(goals, 'Viagem')).toMatchObject({
        targetAmount: 400_000,
        monthlyContribution: 700_000,
      });
    });

    it('matches case, accents and spacing, and tells credits from assets of the same name', async () => {
      const ctx = await t.household();
      await run(ctx, {
        netWorthRows: {
          assets: [{ name: 'Carro', tipo: 'Viatura', months: [100] }],
          liabilities: [{ name: 'Carro', tipo: 'Dívida', months: [50] }],
        },
      });
      await run(
        ctx,
        {
          netWorthRows: {
            assets: [{ name: '  CARRO ', tipo: 'Viatura', months: [200] }],
            liabilities: [{ name: 'cárro', tipo: 'Dívida', months: [60] }],
          },
        },
        AGAIN,
      );
      const { assets, liabilities, valuations, balances } = await rows(ctx);
      expect(assets).toHaveLength(1);
      expect(liabilities).toHaveLength(1);
      expect(valuations.map((v) => v.value)).toEqual([200]);
      expect(balances.map((b) => b.balance)).toEqual([60]);
    });

    it('does not match an archived record, and keeps a linked row linked without values', async () => {
      const ctx = await t.household();
      const cash = await createAccount(ctx, { name: 'Contas à ordem', type: 'checking' });
      await run(ctx);
      const [casa] = (await rows(ctx)).assets.filter((a) => a.name === 'Casa');
      await inHousehold(ctx, (tx) =>
        tx.update(asset).set({ archived: true }).where(eq(asset.id, casa!.id)),
      );
      const { result } = await run(ctx, undefined, AGAIN);
      expect(result.assetsCreated).toBe(1);
      const now = await rows(ctx);
      expect(now.assets.filter((a) => a.name === 'Casa')).toHaveLength(2);
      const linked = named(now.assets, 'Contas à ordem');
      expect(linked.accountId).toBe(cash.id);
      expect(now.valuations.filter((v) => v.assetId === linked.id)).toEqual([]);
    });
  });

  describe('import date, links, positions and currencies', () => {
    const balancesOf = async (ctx: ServiceCtx, name: string) => {
      const now = await rows(ctx);
      const owner = named(now.liabilities, name);
      return now.balances
        .filter((b) => b.liabilityId === owner.id)
        .sort((a, b) => a.asOf.localeCompare(b.asOf));
    };

    it('recomputes the stored net worth months the imported values reach, never filling gaps', async () => {
      const ctx = await t.household();
      const deps = { db: ctx.db, now: NOW };
      for (const month of ['2026-09-01', '2027-01-01', '2027-03-01']) {
        await snapshotNetWorth(deps, ctx.householdId, month);
      }
      const { result } = await run(ctx);
      const stored = await inHousehold(ctx, (tx) =>
        tx.select().from(netWorthSnapshot).where(eq(netWorthSnapshot.householdId, ctx.householdId)),
      );
      const net = new Map(stored.map((r) => [r.month, r.net]));
      // September 2026 is before the first imported month: left alone
      expect(net.get('2026-09-01')).toBe(0);
      expect(net.get('2027-01-01')).toBe((await netWorthAt(ctx, '2027-01-31')).net);
      expect(net.get('2027-03-01')).toBe((await netWorthAt(ctx, '2027-03-31')).net);
      expect(net.get('2027-01-01')).not.toBe(0);
      expect([...net.keys()].sort()).toEqual(['2026-09-01', '2027-01-01', '2027-03-01']);
      expect(result.snapshotsRefreshed).toBe(2);
    });

    it('writes only months that have ended, and a future "-" or 0 never zeroes a credit', async () => {
      const ctx = await t.household();
      const june = new Date('2027-06-15T12:00:00Z');
      const previewed = await previewAt(ctx, await file(), june);
      await commitAt(ctx, previewed.token, ALL, june);
      const loan = await balancesOf(ctx, 'Empréstimo Auto');
      expect(loan).toHaveLength(8);
      expect(loan.at(-1)).toMatchObject({ asOf: '2027-05-31', balance: 100_000 });
      const now = await rows(ctx);
      const house = now.valuations.filter((v) => v.assetId === named(now.assets, 'Casa').id);
      expect(house).toHaveLength(8);
    });

    it('applies the import date again at commit, in the household time zone', async () => {
      const ctx = await t.household();
      await inHousehold(ctx, (tx) =>
        tx
          .update(schema.householdSettings)
          .set({ timezone: 'Pacific/Auckland' })
          .where(eq(schema.householdSettings.householdId, ctx.householdId)),
      );
      const previewed = await previewAt(ctx, await file(), NOW);
      // 2027-05-31 at 20:00 UTC is already 1 June in Auckland: May has ended there, June has not.
      await commitAt(ctx, previewed.token, ALL, new Date('2027-05-31T20:00:00Z'));
      const house = (await rows(ctx)).valuations;
      expect(
        house
          .map((v) => v.asOf)
          .sort()
          .at(-1),
      ).toBe('2027-05-31');
    });

    it('shows the current link of a matched record and lets an explicit null unlink it', async () => {
      const ctx = await t.household();
      const cash = await createAccount(ctx, { name: 'Contas à ordem', type: 'checking' });
      await run(ctx);
      const previewed = await previewAt(ctx, await file());
      expect(named(previewed.patrimonio!.assets, 'Contas à ordem').currentAccountId).toBe(cash.id);
      expect(named(previewed.patrimonio!.assets, 'Casa').currentAccountId).toBeNull();

      await commitAt(ctx, previewed.token, {
        ...AGAIN,
        accountLinks: { 'asset:contas a ordem': null },
      });
      const now = await rows(ctx);
      const unlinked = named(now.assets, 'Contas à ordem');
      expect(unlinked.accountId).toBeNull();
      expect(now.valuations.filter((v) => v.assetId === unlinked.id)).toHaveLength(12);
    });

    it('does not suggest an account another record already counts, and refuses linking it twice', async () => {
      const ctx = await t.household();
      const acc = await createAccount(ctx, { name: 'Contas à ordem', type: 'checking' });
      const mine = await createAsset(ctx, { kind: 'cash', name: 'Mealheiro', accountId: acc.id });
      const { preview } = await run(ctx);
      expect(
        preview.patrimonio!.assets.find((r) => r.name === 'Contas à ordem')!.suggestedAccountId,
      ).toBeNull();
      const { assets } = await rows(ctx);
      expect(named(assets, 'Contas à ordem').accountId).toBeNull();
      expect(named(assets, 'Mealheiro').accountId).toBe(acc.id);
      void mine;

      // the account a matched record itself counts is still its suggestion
      const own = await t.household();
      const ownAcc = await createAccount(own, { name: 'Contas à ordem', type: 'checking' });
      await createAsset(own, { kind: 'cash', name: 'Contas à ordem', accountId: ownAcc.id });
      const ownPreview = await previewAt(own, await file());
      expect(
        ownPreview.patrimonio!.assets.find((r) => r.name === 'Contas à ordem')!.suggestedAccountId,
      ).toBe(ownAcc.id);

      const fresh = await t.household();
      const shared = await createAccount(fresh, { name: 'Partilhada', type: 'checking' });
      const previewed = await previewAt(fresh, await file());
      const err = await commitAt(fresh, previewed.token, {
        ...ALL,
        accountLinks: { 'asset:casa': shared.id, 'asset:carro': shared.id },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('account_already_linked');
    });

    it('keeps the existing link when the key is absent, and applies the suggestion only to new rows', async () => {
      const ctx = await t.household();
      const mine = await createAccount(ctx, { name: 'Minha', type: 'savings' });
      await run(ctx);
      const casa = named((await rows(ctx)).assets, 'Casa');
      await inHousehold(ctx, (tx) =>
        tx.update(asset).set({ accountId: mine.id }).where(eq(asset.id, casa.id)),
      );
      // A matching account appears after the first import: only a new row would take it.
      await createAccount(ctx, { name: 'Casa', type: 'other' });
      await createAccount(ctx, { name: 'Carro', type: 'other' });
      await run(ctx, undefined, AGAIN);
      const now = await rows(ctx);
      expect(named(now.assets, 'Casa').accountId).toBe(mine.id);
      expect(named(now.assets, 'Carro').accountId).toBeNull();
    });

    it('clears the target and contribution of a matched goal when the sheet cell is blank', async () => {
      const ctx = await t.household();
      await run(ctx);
      await inHousehold(ctx, (tx) =>
        tx
          .update(goal)
          .set({ targetAmount: 5, monthlyContribution: 6 })
          .where(eq(goal.name, 'Viagem')),
      );
      await run(
        ctx,
        {
          patchGoals: [
            { row: 4, col: 'B', value: '' },
            { row: 4, col: 'D', value: '' },
          ],
        },
        AGAIN,
      );
      expect(named((await rows(ctx)).goals, 'Viagem')).toMatchObject({
        targetAmount: null,
        monthlyContribution: null,
      });
    });

    it('keeps existing notes when the Notas cell is blank', async () => {
      const ctx = await t.household();
      await run(ctx);
      await run(ctx, { patchNetWorth: [{ row: 4, col: 'C', value: '' }] }, AGAIN);
      expect(named((await rows(ctx)).assets, 'Casa').notes).toBe('Valor de mercado');
    });

    it('keeps the order of matched records and appends new ones', async () => {
      const ctx = await t.household();
      await run(ctx);
      const casa = named((await rows(ctx)).assets, 'Casa');
      await inHousehold(ctx, (tx) =>
        tx.update(asset).set({ position: 50 }).where(eq(asset.id, casa.id)),
      );
      await run(ctx, { extraAssets: [{ name: 'Arte', tipo: 'Liquidez', months: [100] }] }, AGAIN);
      const now = await rows(ctx);
      expect(named(now.assets, 'Casa').position).toBe(50);
      expect(named(now.assets, 'Carro').position).toBe(1);
      expect(named(now.assets, 'Arte').position).toBe(51);
    });

    it('follows the sheet for the kind of a matched record', async () => {
      const ctx = await t.household();
      await run(ctx);
      await run(
        ctx,
        {
          netWorthRows: {
            assets: [{ name: 'Carro', tipo: 'Imóvel', months: [100] }],
            liabilities: [],
          },
        },
        AGAIN,
      );
      expect(named((await rows(ctx)).assets, 'Carro').kind).toBe('real_estate');
    });

    it('writes no values for a matched asset in another currency and warns', async () => {
      const ctx = await t.household({ currency: 'EUR' });
      const usd = await createAsset(ctx, { kind: 'real_estate', name: 'Casa', currency: 'USD' });
      const previewed = await previewAt(ctx, await file());
      expect(previewed.warnings).toContainEqual({
        code: 'currency_mismatch',
        params: { name: 'Casa' },
      });
      const result = await commitAt(ctx, previewed.token, ALL);
      expect(result.warnings).toContainEqual({
        code: 'currency_mismatch',
        params: { name: 'Casa' },
      });
      const now = await rows(ctx);
      expect(now.valuations.filter((v) => v.assetId === usd.id)).toEqual([]);
      expect(now.valuations.filter((v) => v.assetId === named(now.assets, 'Carro').id)).not.toEqual(
        [],
      );
    });

    it('refuses more than 200 assets at preview, before anything is written', async () => {
      const ctx = await t.household();
      const many = Array.from({ length: 201 }, (_, i) => ({
        name: `Item ${i}`,
        tipo: 'Liquidez',
        months: [1],
      }));
      await expect(
        previewAt(ctx, await file({ netWorthRows: { assets: many, liabilities: [] } })),
      ).rejects.toMatchObject({ code: 'too_many_rows', params: { section: 'assets', max: 200 } });
      expect(
        await t.owner.select().from(undoToken).where(eq(undoToken.householdId, ctx.householdId)),
      ).toEqual([]);
    });
  });
});
