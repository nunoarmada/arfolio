import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  addAssetValuation,
  categoriseTransaction,
  createAccount,
  createAsset,
  createBudget,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  disposeAsset,
  householdToday,
  listCategories,
  markTransfer,
  saveBudgetLine,
  seedCategoryTemplates,
  type ServiceCtx,
} from '@arfolio/services';
import {
  caller,
  connect,
  errorCode,
  seedTwoHouseholds,
  startServicesDb,
  type ServicesTestDb,
  type ToolResult,
} from './harness.js';

const { auditLog, transaction, rule, assetValuation } = schema;

const READ_TOOLS = [
  'get_overview',
  'list_accounts',
  'list_categories',
  'search_transactions',
  'get_budget_vs_actual',
  'get_net_worth',
  'list_review_inbox',
];
const WRITE_TOOLS = [
  'categorise_transaction',
  'create_manual_transaction',
  'update_asset_valuation',
  'create_rule',
];
const flat = (n: number): number[] => Array.from({ length: 12 }, () => n);

describe('Arfolio MCP tools', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let checking: string;
  let savings: string;
  let food: string;
  let fun: string;
  let salary: string;
  let budgetId: string;
  let assetId: string;
  // Household B's ids, which household A's tools must never reach.
  let bAccount: string;
  let bCategory: string;
  let bTx: string;
  let bAsset: string;

  const audit = (ctx: ServiceCtx) =>
    t.owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.householdId, ctx.householdId))
      .orderBy(auditLog.createdAt);
  const txRows = (ctx: ServiceCtx) =>
    t.owner.select().from(transaction).where(eq(transaction.householdId, ctx.householdId));
  const manual = (ctx: ServiceCtx, over: Record<string, unknown> = {}) =>
    createManualTransaction(ctx, {
      accountId: checking,
      bookingDate: '2026-04-10',
      amount: -1_000,
      description: 'Lunch spot',
      ...over,
    });

  beforeAll(async () => {
    t = await startServicesDb();
    ({ a, b } = await seedTwoHouseholds(t));

    await seedCategoryTemplates(a, 'en');
    const expenseGroup = await createCategoryGroup(a, { name: 'Daily', kind: 'expense' });
    const incomeGroup = await createCategoryGroup(a, { name: 'Pay', kind: 'income' });
    food = (await createCategory(a, { groupId: expenseGroup.id, name: 'Food' })).id;
    fun = (await createCategory(a, { groupId: expenseGroup.id, name: 'Fun' })).id;
    salary = (await createCategory(a, { groupId: incomeGroup.id, name: 'Salary' })).id;
    checking = (await createAccount(a, { name: 'Checking', type: 'checking' })).id;
    savings = (await createAccount(a, { name: 'Savings', type: 'savings' })).id;

    // April 2026: salary in, food out (categorised), one uncategorised row to review, one transfer.
    await manual(a, {
      bookingDate: '2026-04-01',
      amount: 300_000,
      description: 'ACME payroll',
      categoryId: salary,
    });
    await manual(a, {
      bookingDate: '2026-04-05',
      amount: -4_000,
      description: 'Groceries',
      categoryId: food,
    });
    await manual(a, { bookingDate: '2026-04-09', amount: -2_500, description: 'Mystery shop' });
    const out = await manual(a, {
      bookingDate: '2026-04-20',
      amount: -50_000,
      description: 'Move to savings',
    });
    const inn = await manual(a, {
      accountId: savings,
      bookingDate: '2026-04-20',
      amount: 50_000,
      description: 'From checking',
    });
    await markTransfer(a, out.id, inn.id);

    const budget = await createBudget(a, { startMonth: '2026-01-01' });
    budgetId = budget.id;
    await saveBudgetLine(a, budget.id, {
      line: { kind: 'expense', name: 'Food' },
      amounts: flat(30_000),
      categoryIds: [food],
    });

    // Two saving lines (no pies) on the same non-hub account: its booked money is unassigned.
    for (const name of ['Emergency fund', 'Holiday']) {
      await saveBudgetLine(a, budget.id, {
        line: { kind: 'saving', name, accountId: savings },
        amounts: flat(0),
        categoryIds: [],
      });
    }

    assetId = (await createAsset(a, { kind: 'real_estate', name: 'Flat' })).id;

    const bGroup = await createCategoryGroup(b, { name: 'B', kind: 'expense' });
    bCategory = (await createCategory(b, { groupId: bGroup.id, name: 'B cat' })).id;
    bAccount = (await createAccount(b, { name: 'B acc', type: 'checking' })).id;
    bTx = (
      await createManualTransaction(b, {
        accountId: bAccount,
        bookingDate: '2026-04-10',
        amount: -999,
        description: 'B secret',
      })
    ).id;
    bAsset = (await createAsset(b, { kind: 'cash', name: 'B stash' })).id;
  });
  afterAll(() => t.close());

  describe('tool surface', () => {
    it('registers exactly the read and write tools, none destructive', async () => {
      const { client, close } = await connect(caller(a));
      const tools = (await client.listTools()).tools;
      expect(tools.map((x) => x.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
      for (const tool of tools) {
        const ann = tool.annotations;
        if (READ_TOOLS.includes(tool.name)) expect(ann?.readOnlyHint).toBe(true);
        else expect(ann).toMatchObject({ destructiveHint: false, idempotentHint: false });
        expect(tool.description?.length).toBeGreaterThan(20);
        expect(tool.outputSchema).toBeDefined();
      }
      await close();
    });

    it('takes no household argument on any tool (Review Focus 1)', async () => {
      const { client, close } = await connect(caller(a));
      for (const tool of (await client.listTools()).tools) {
        const props = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
        );
        expect(props.filter((p) => /household|organi[sz]ation|tenant/i.test(p))).toEqual([]);
      }
      await close();
    });

    it('states units, untrusted text and non-idempotency in the descriptions', async () => {
      const { client, close } = await connect(caller(a));
      const by = new Map((await client.listTools()).tools.map((x) => [x.name, x.description]));
      expect(by.get('search_transactions')).toMatch(/untrusted/i);
      expect(by.get('list_review_inbox')).toMatch(/untrusted/i);
      expect(by.get('create_manual_transaction')).toMatch(/not idempotent/i);
      expect(by.get('create_manual_transaction')).toMatch(/decimal string/i);
      await close();
    });

    it('rejects a forged household argument without acting on it', async () => {
      const { call, close } = await connect(caller(a));
      const before = (await txRows(b)).length;
      const r = await call('create_manual_transaction', {
        household_id: b.householdId,
        account_id: bAccount,
        booking_date: '2026-04-11',
        amount: '-1.00',
        description: 'forged',
      });
      expect(r.isError).toBe(true);
      expect((await txRows(b)).length).toBe(before);
      expect((await audit(b)).length).toBe(0);
      const read = await call('list_accounts', { householdId: b.householdId });
      expect(read.isError).toBe(true);
      await close();
    });
  });

  describe('read tools', () => {
    it('get_overview: month income and spend per currency without the transfer, review count, budget, net worth', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('get_overview', { month: '2026-04' });
      expect(r.isError).toBeUndefined();
      const o = r.structuredContent!;
      expect(o.month).toBe('2026-04');
      expect(o.spending).toHaveLength(1);
      expect(o.spending[0]).toMatchObject({
        income: { amount: '3000.00', amount_minor: '300000', currency: 'EUR' },
        // 40.00 + 25.00; the 500.00 transfer is excluded.
        expense: { amount: '65.00', amount_minor: '6500', currency: 'EUR' },
        transactions: 3,
        uncategorised: 1,
      });
      expect(o.review_count).toBeGreaterThanOrEqual(1);
      expect(o.budget).toMatchObject({
        id: budgetId,
        month_index: 4,
        totals: {
          expense: {
            planned: { amount: '300.00' },
            actual: { amount: '40.00' },
          },
        },
      });
      expect(o.net_worth).toMatchObject({ currency: 'EUR' });
      expect(JSON.parse(r.content[0]!.text)).toEqual(o);
      await close();
    });

    it('get_overview: defaults to the current month and reports no budget where none covers it', async () => {
      const { call, close } = await connect(caller(b));
      const today = (await householdToday(b)).today;
      const r = await call('get_overview');
      expect(r.structuredContent).toMatchObject({ month: today.slice(0, 7), budget: null });
      await close();
    });

    it('get_overview: rejects a malformed month', async () => {
      const { call, close } = await connect(caller(a));
      expect((await call('get_overview', { month: '2026-13' })).isError).toBe(true);
      await close();
    });

    it('list_accounts: lists open accounts with decimal balances; archived only on request', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('list_accounts');
      const accounts = r.structuredContent!.accounts as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(accounts.map((x) => x.name).sort()).toEqual(['Checking', 'Savings']);
      const checkingRow = accounts.find((x) => x.id === checking)!;
      // 3000.00 - 40.00 - 25.00 - 500.00 (transfer out).
      expect(checkingRow.balance).toEqual({
        amount: '2435.00',
        amount_minor: '243500',
        currency: 'EUR',
      });
      expect(checkingRow).toMatchObject({ type: 'checking', currency: 'EUR', archived: false });
      expect(Object.keys(checkingRow)).not.toContain('householdId');
      const all = await call('list_accounts', { include_archived: true });
      expect(all.structuredContent!.accounts).toHaveLength(2);
      await close();
    });

    it('list_categories: groups with their categories and ids', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('list_categories');
      const groups = r.structuredContent!.groups as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const daily = groups.find((g) => g.name === 'Daily')!;
      expect(daily.kind).toBe('expense');
      expect(daily.categories.map((c: { id: string }) => c.id)).toEqual(
        expect.arrayContaining([food, fun]),
      );
      expect(groups.flatMap((g) => g.categories).map((c: { id: string }) => c.id)).not.toContain(
        bCategory,
      );
      await close();
    });

    it('search_transactions: filters by text, returns money and external text as data', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('search_transactions', { query: 'payroll' });
      expect(r.structuredContent!.transactions).toHaveLength(1);
      expect(r.structuredContent!.transactions[0]).toMatchObject({
        description: 'ACME payroll',
        booking_date: '2026-04-01',
        amount: { amount: '3000.00', amount_minor: '300000', currency: 'EUR' },
        category_id: salary,
        account_id: checking,
      });
      const review = await call('search_transactions', { needs_review: true, uncategorised: true });
      expect(
        review.structuredContent!.transactions.map((x: { description: string }) => x.description),
      ).toContain('Mystery shop');
      await close();
    });

    it('search_transactions: returns the transaction date, time and merchant category (with label)', async () => {
      await t.owner
        .update(transaction)
        .set({
          transactionDate: '2026-04-04',
          occurredAt: new Date('2026-04-04T18:20:00Z'),
          mcc: '5411',
        })
        .where(
          and(
            eq(transaction.householdId, a.householdId),
            eq(transaction.rawDescription, 'Groceries'),
          ),
        );
      const { call, close } = await connect(caller(a));
      const r = await call('search_transactions', { query: 'groceries' });
      expect(r.structuredContent!.transactions[0]).toMatchObject({
        transaction_date: '2026-04-04',
        occurred_at: '2026-04-04T18:20:00.000Z',
        mcc: '5411',
        mcc_label: 'Grocery stores and supermarkets',
      });
      const plain = await call('search_transactions', { query: 'payroll' });
      expect(plain.structuredContent!.transactions[0]).toMatchObject({
        transaction_date: null,
        occurred_at: null,
        mcc: null,
        mcc_label: null,
      });
      await close();
    });

    it('search_transactions: never returns another household’s rows, even when asked by their ids', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('search_transactions', { account_ids: [bAccount] });
      expect(r.structuredContent!.transactions).toEqual([]);
      const text = await call('search_transactions', { query: 'B secret' });
      expect(text.structuredContent!.transactions).toEqual([]);
      await close();
    });

    it('search_transactions: the cursor round-trips through every page exactly once', async () => {
      const { call, close } = await connect(caller(a));
      const everything = await call('search_transactions', { limit: 100 });
      const all: string[] = everything.structuredContent!.transactions.map(
        (x: { id: string }) => x.id,
      );
      expect(all.length).toBeGreaterThanOrEqual(5);
      expect(everything.structuredContent!.next_cursor).toBeNull();

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: ToolResult = await call('search_transactions', {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        const ids = page.structuredContent!.transactions.map((x: { id: string }) => x.id);
        expect(ids.length).toBeLessThanOrEqual(2);
        seen.push(...ids);
        cursor = page.structuredContent!.next_cursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      await close();
    });

    it('search_transactions: rejects a limit over 100 and a tampered cursor', async () => {
      const { call, close } = await connect(caller(a));
      expect((await call('search_transactions', { limit: 101 })).isError).toBe(true);
      const bad = await call('search_transactions', { cursor: 'not-a-cursor' });
      expect(bad.isError).toBe(true);
      expect(errorCode(bad)).toBe('invalid_input');
      await close();
    });

    it('list_review_inbox: only rows waiting for review, paged', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('list_review_inbox', { limit: 50 });
      const rows = r.structuredContent!.transactions as Array<{
        description: string;
        needs_review: boolean;
      }>;
      expect(rows.map((x) => x.description)).toContain('Mystery shop');
      expect(rows.every((x) => x.needs_review)).toBe(true);
      expect(rows.map((x) => x.description)).not.toContain('B secret');
      await close();
    });

    it('get_budget_vs_actual: month view with decimal planned, actual and remaining', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('get_budget_vs_actual', { year: 2026, month: 4 });
      const s = r.structuredContent!;
      expect(s.budget).toMatchObject({ id: budgetId, start_month: '2026-01-01' });
      expect(s.month).toMatchObject({ month: '2026-04', currency: 'EUR' });
      expect(s.month.lines[0]).toMatchObject({
        name: 'Food',
        kind: 'expense',
        planned: { amount: '300.00' },
        actual: { amount: '40.00' },
        remaining: { amount: '260.00' },
        percent: 13,
      });
      await close();
    });

    it('get_budget_vs_actual: year view when no month is given; null when no budget covers the period', async () => {
      const { call, close } = await connect(caller(a));
      const y = await call('get_budget_vs_actual', { year: 2026 });
      expect(y.structuredContent!.budget).toMatchObject({ id: budgetId });
      expect(y.structuredContent!.year.totals.expense.total.planned.amount).toBe('3600.00');
      expect(y.structuredContent!.year.totals.expense.months).toHaveLength(12);
      const none = await call('get_budget_vs_actual', { year: 2031, month: 6 });
      expect(none.isError).toBeUndefined();
      expect(none.structuredContent).toEqual({ budget: null });
      const noneYear = await call('get_budget_vs_actual', { year: 2031 });
      expect(noneYear.structuredContent).toEqual({ budget: null });
      await close();
    });

    it('get_budget_vs_actual: unassigned savings and no-data flags on saving lines', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('get_budget_vs_actual', { year: 2026, month: 4 });
      const s = r.structuredContent!;
      const saving = s.month.lines.filter((l: { kind: string }) => l.kind === 'saving');
      expect(saving.map((l: { name: string }) => l.name)).toEqual(['Emergency fund', 'Holiday']);
      for (const line of s.month.lines) {
        expect(line).toMatchObject({ no_data: false, stale_as_of: null });
      }
      expect(s.month.unassigned_savings).toEqual([
        {
          account_id: savings,
          account_name: 'Savings',
          actual: { amount: '500.00', amount_minor: '50000', currency: 'EUR' },
        },
      ]);

      const y = await call('get_budget_vs_actual', { year: 2026 });
      const emergency = y.structuredContent!.year.lines.find(
        (l: { name: string }) => l.name === 'Emergency fund',
      );
      expect(emergency.months).toHaveLength(12);
      expect(emergency.months[3]).toMatchObject({ month: '2026-04', no_data: false });
      await close();
    });

    it('get_budget_vs_actual: rejects a month outside 1..12', async () => {
      const { call, close } = await connect(caller(a));
      expect((await call('get_budget_vs_actual', { month: 13 })).isError).toBe(true);
      await close();
    });

    it('get_net_worth: today plus history, money as decimal strings; assets valued in minor units', async () => {
      const w = await t.household({ currency: 'EUR' });
      const asset = await createAsset(w, { kind: 'real_estate', name: 'House' });
      await addAssetValuation(w, asset.id, { asOf: '2026-01-01', value: 25_000_000 });
      const { call, close } = await connect(caller(w));
      const r = await call('get_net_worth', { history_months: 6 });
      expect(r.structuredContent!.today).toMatchObject({
        currency: 'EUR',
        assets: { amount: '250000.00', amount_minor: '25000000', currency: 'EUR' },
        liabilities: { amount: '0.00' },
        net: { amount: '250000.00' },
      });
      expect(r.structuredContent!.history.length).toBeGreaterThanOrEqual(1);
      expect(r.structuredContent!.history.at(-1).net.amount).toBe('250000.00');
      const none = await call('get_net_worth', { history_months: 0 });
      expect(none.structuredContent!.history).toEqual([]);
      expect((await call('get_net_worth', { history_months: 61 })).isError).toBe(true);
      await close();
    });
  });

  describe('write tools', () => {
    it('categorise_transaction: categorises, leaves review, and writes one audit row', async () => {
      const row = await manual(a, { description: 'Cinema night', bookingDate: '2026-04-12' });
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a, ['pfm:read', 'pfm:write'], 'pat:abc'));
      const r = await call('categorise_transaction', {
        transaction_id: row.id,
        category_id: fun,
        apply_to_merchant: false,
      });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent).toMatchObject({
        transaction: { id: row.id, category_id: fun, needs_review: false },
        also_applied: 0,
      });
      const rows = await audit(a);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({
        actor: 'mcp',
        action: 'transaction.categorise',
        targetType: 'transaction',
        targetId: row.id,
        credential: 'pat:abc',
        userId: 'user-1',
      });
      await close();
    });

    it('create_manual_transaction: parses the decimal string and stores it in the account currency', async () => {
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const r = await call('create_manual_transaction', {
        account_id: checking,
        booking_date: '2026-05-02',
        amount: '-12.34',
        description: 'Coffee beans',
        counterparty: 'Roaster',
        category_id: food,
        notes: 'tip included',
      });
      expect(r.isError).toBeUndefined();
      const created = r.structuredContent!.transaction;
      expect(created).toMatchObject({
        account_id: checking,
        amount: { amount: '-12.34', amount_minor: '-1234', currency: 'EUR' },
        description: 'Coffee beans',
        counterparty: 'Roaster',
        category_id: food,
        notes: 'tip included',
        source: 'manual',
      });
      const [stored] = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.id, created.id));
      expect(stored).toMatchObject({ amount: -1234, currency: 'EUR', source: 'manual' });
      const rows = await audit(a);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({
        action: 'transaction.create',
        targetType: 'transaction',
        targetId: created.id,
        actor: 'mcp',
      });
      // The audit row holds ids only, never the amount.
      expect(JSON.stringify(rows.at(-1))).not.toContain('1234');
      await close();
    });

    it('update_asset_valuation: records a manual value and audits it', async () => {
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const r = await call('update_asset_valuation', {
        asset_id: assetId,
        value: '180000.50',
        date: '2026-03-31',
      });
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent!.valuation).toMatchObject({
        asset_id: assetId,
        date: '2026-03-31',
        value: { amount: '180000.50', amount_minor: '18000050', currency: 'EUR' },
        method: 'manual',
        estimate: null,
      });
      const [row] = await t.owner
        .select()
        .from(assetValuation)
        .where(eq(assetValuation.assetId, assetId));
      expect(row).toMatchObject({ value: 18_000_050, method: 'manual' });
      const rows = await audit(a);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({
        action: 'asset.valuation',
        targetType: 'asset',
        targetId: assetId,
      });
      await close();
    });

    it('create_rule: creates a rule from the shared condition schema and audits it', async () => {
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const r = await call('create_rule', {
        name: 'Roaster to food',
        category_id: food,
        condition: { counterpartyContains: 'Roaster', direction: 'out' },
      });
      expect(r.isError).toBeUndefined();
      const created = r.structuredContent!.rule;
      expect(created).toMatchObject({
        name: 'Roaster to food',
        category_id: food,
        condition: { counterpartyContains: 'Roaster', direction: 'out' },
        enabled: true,
      });
      const [stored] = await t.owner.select().from(rule).where(eq(rule.id, created.id));
      expect(stored!.householdId).toBe(a.householdId);
      const rows = await audit(a);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({
        action: 'rule.create',
        targetType: 'rule',
        targetId: created.id,
      });
      await close();
    });

    it('create_rule: amounts in the condition are decimal strings, stored as minor units', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('create_rule', {
        name: 'Big spends',
        category_id: food,
        condition: { amountMin: '-250.50', amountMax: '-10', direction: 'out' },
      });
      expect(r.isError).toBeUndefined();
      const [stored] = await t.owner
        .select()
        .from(rule)
        .where(eq(rule.id, r.structuredContent!.rule.id));
      expect(stored!.condition).toMatchObject({ amountMin: -25_050, amountMax: -1_000 });
      expect(r.structuredContent!.rule.condition).toMatchObject({
        amountMin: '-250.50',
        amountMax: '-10.00',
      });
      await close();
    });

    it.each(['12,34', '1e3', '0.001', '+5', ''])(
      'create_rule: amountMin %j is invalid_input, no rule and no audit row',
      async (amountMin) => {
        const before = {
          audit: (await audit(a)).length,
          rules: (await t.owner.select().from(rule)).length,
        };
        const { call, close } = await connect(caller(a));
        const r = await call('create_rule', {
          name: 'Bad amount',
          category_id: food,
          condition: { amountMin },
        });
        expect(errorCode(r)).toBe('invalid_input');
        expect((await audit(a)).length).toBe(before.audit);
        expect((await t.owner.select().from(rule)).length).toBe(before.rules);
        await close();
      },
    );

    it('create_rule: a numeric amount is rejected (strings only)', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('create_rule', {
        name: 'Numeric',
        category_id: food,
        condition: { amountMin: 1000 },
      });
      expect(r.isError).toBe(true);
      await close();
    });

    it('create_rule: an empty condition is invalid input and writes nothing', async () => {
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const r = await call('create_rule', { name: 'Empty', category_id: food, condition: {} });
      expect(r.isError).toBe(true);
      expect((await audit(a)).length).toBe(before);
      await close();
    });
  });

  describe('cross-household access (Review Focus 1)', () => {
    it('answers not_found for another household’s ids and writes nothing', async () => {
      const before = { audit: (await audit(a)).length, txB: (await txRows(b)).length };
      const { call, close } = await connect(caller(a));
      const results = await Promise.all([
        call('categorise_transaction', { transaction_id: bTx, category_id: food }),
        call('categorise_transaction', {
          transaction_id: (await txRows(a))[0]!.id,
          category_id: bCategory,
        }),
        call('create_manual_transaction', {
          account_id: bAccount,
          booking_date: '2026-04-11',
          amount: '-1.00',
          description: 'into B',
        }),
        call('create_manual_transaction', {
          account_id: checking,
          booking_date: '2026-04-11',
          amount: '-1.00',
          description: 'B category',
          category_id: bCategory,
        }),
        call('update_asset_valuation', { asset_id: bAsset, value: '1.00', date: '2026-04-01' }),
        call('create_rule', {
          name: 'x',
          category_id: bCategory,
          condition: { descriptionContains: 'x' },
        }),
      ]);
      for (const r of results) {
        expect(r.isError).toBe(true);
        expect(errorCode(r)).toBe('not_found');
      }
      expect((await audit(a)).length).toBe(before.audit);
      expect((await txRows(b)).length).toBe(before.txB);
      expect((await audit(b)).length).toBe(0);
      const [still] = await t.owner.select().from(transaction).where(eq(transaction.id, bTx));
      expect(still!.categoryId).toBeNull();
      await close();
    });

    it('answers not_found for a malformed id as well', async () => {
      const { call, close } = await connect(caller(a));
      const r = await call('categorise_transaction', { transaction_id: 'nope', category_id: food });
      expect(errorCode(r)).toBe('not_found');
      await close();
    });
  });

  describe('scope and role (Review Focus 2)', () => {
    const writeCalls: Array<[string, () => Record<string, unknown>]> = [
      ['categorise_transaction', () => ({ transaction_id: bTx, category_id: food })],
      [
        'create_manual_transaction',
        () => ({
          account_id: checking,
          booking_date: '2026-06-01',
          amount: '-1.00',
          description: 'should not exist',
        }),
      ],
      ['update_asset_valuation', () => ({ asset_id: assetId, value: '1.00', date: '2026-06-01' })],
      [
        'create_rule',
        () => ({ name: 'nope', category_id: food, condition: { descriptionContains: 'nope' } }),
      ],
    ];

    it.each(writeCalls)(
      'a read-only credential calling %s gets insufficient_scope and changes nothing',
      async (name, args) => {
        const before = { audit: (await audit(a)).length, tx: (await txRows(a)).length };
        const { call, close } = await connect(caller(a, ['pfm:read']));
        const r = await call(name, args());
        expect(r.isError).toBe(true);
        expect(errorCode(r)).toBe('insufficient_scope');
        expect(r.structuredContent!.error.message).toMatch(/pfm:write/);
        expect((await audit(a)).length).toBe(before.audit);
        expect((await txRows(a)).length).toBe(before.tx);
        await close();
      },
    );

    it.each(writeCalls)(
      'a viewer with the write scope calling %s gets forbidden and changes nothing',
      async (name, args) => {
        const before = { audit: (await audit(a)).length, tx: (await txRows(a)).length };
        const viewer: ServiceCtx = { ...a, role: 'viewer' };
        const { call, close } = await connect(caller(viewer, ['pfm:read', 'pfm:write']));
        const r = await call(name, args());
        expect(r.isError).toBe(true);
        expect(errorCode(r)).toBe('forbidden');
        expect((await audit(a)).length).toBe(before.audit);
        expect((await txRows(a)).length).toBe(before.tx);
        await close();
      },
    );

    it('a viewer can still read with the read scope', async () => {
      const viewer: ServiceCtx = { ...a, role: 'viewer' };
      const { call, close } = await connect(caller(viewer, ['pfm:read']));
      expect((await call('list_accounts')).isError).toBeUndefined();
      await close();
    });

    it('a credential without the read scope cannot read', async () => {
      const { call, close } = await connect(caller(a, ['pfm:write']));
      const r = await call('list_accounts');
      expect(errorCode(r)).toBe('insufficient_scope');
      await close();
    });

    it('a member with the write scope can write', async () => {
      const member: ServiceCtx = { ...a, role: 'member' };
      const { call, close } = await connect(caller(member));
      const r = await call('create_manual_transaction', {
        account_id: checking,
        booking_date: '2026-06-02',
        amount: '-1.00',
        description: 'member write',
      });
      expect(r.isError).toBeUndefined();
      await close();
    });
  });

  describe('money input (Review Focus 5)', () => {
    it.each(['12,34', '1e3', '0.001', '12.345', '+5', '1 000.00', '€5', '', '5.', '.5'])(
      'rejects amount %j as invalid_input and writes nothing',
      async (amount) => {
        const before = { audit: (await audit(a)).length, tx: (await txRows(a)).length };
        const { call, close } = await connect(caller(a));
        const r = await call('create_manual_transaction', {
          account_id: checking,
          booking_date: '2026-06-03',
          amount,
          description: 'bad amount',
        });
        expect(r.isError).toBe(true);
        expect(errorCode(r)).toBe('invalid_input');
        expect((await audit(a)).length).toBe(before.audit);
        expect((await txRows(a)).length).toBe(before.tx);
        await close();
      },
    );

    it.each(['12,34', '1e3', '-1.00', '0.001'])(
      'rejects asset value %j as invalid_input',
      async (value) => {
        const { call, close } = await connect(caller(a));
        const r = await call('update_asset_valuation', {
          asset_id: assetId,
          value,
          date: '2026-06-03',
        });
        expect(errorCode(r)).toBe('invalid_input');
        await close();
      },
    );

    it('two identical create_manual_transaction calls create two rows and two audit rows', async () => {
      const args = {
        account_id: checking,
        booking_date: '2026-06-04',
        amount: '-7.50',
        description: 'Twice',
      };
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const one = await call('create_manual_transaction', args);
      const two = await call('create_manual_transaction', args);
      expect(one.structuredContent!.transaction.id).not.toBe(two.structuredContent!.transaction.id);
      const twice = (await txRows(a)).filter((x) => x.rawDescription === 'Twice');
      expect(twice).toHaveLength(2);
      expect((await audit(a)).length).toBe(before + 2);
      await close();
    });
  });

  describe('errors', () => {
    it('writes no audit row when the write fails after validation (not_found account)', async () => {
      const before = (await audit(a)).length;
      const { call, close } = await connect(caller(a));
      const r = await call('create_manual_transaction', {
        account_id: '00000000-0000-4000-8000-000000000000',
        booking_date: '2026-06-05',
        amount: '-1.00',
        description: 'ghost account',
      });
      expect(errorCode(r)).toBe('not_found');
      expect((await audit(a)).length).toBe(before);
      await close();
    });

    it('update_asset_valuation refuses a date on or after the disposal, and accepts one before it', async () => {
      const disposed = (await createAsset(a, { kind: 'vehicle', name: 'Old van' })).id;
      await disposeAsset(a, disposed, { kind: 'written_off', date: '2026-03-10' });
      const { call, close } = await connect(caller(a));
      const on = await call('update_asset_valuation', {
        asset_id: disposed,
        value: '900.00',
        date: '2026-03-10',
      });
      expect(errorCode(on)).toBe('invalid_input');
      expect(on.structuredContent!.error.message).toMatch(/written off/);
      const after = await call('update_asset_valuation', {
        asset_id: disposed,
        value: '900.00',
        date: '2026-03-11',
      });
      expect(errorCode(after)).toBe('invalid_input');
      const before = await call('update_asset_valuation', {
        asset_id: disposed,
        value: '900.00',
        date: '2026-03-09',
      });
      expect(before.isError).toBeUndefined();
      expect(before.structuredContent!.valuation).toMatchObject({ date: '2026-03-09' });
      await close();
    });

    it('service validation failures are invalid_input', async () => {
      const { call, close } = await connect(caller(a));
      const transferCat = (await listCategories(a))
        .flatMap((g) => g.categories)
        .find((c) => c.templateKey === 'transfer.between_accounts')!;
      const r = await call('create_manual_transaction', {
        account_id: checking,
        booking_date: '2026-06-05',
        amount: '-1.00',
        description: 'as transfer',
        category_id: transferCat.id,
      });
      expect(errorCode(r)).toBe('invalid_input');
      const date = await call('create_manual_transaction', {
        account_id: checking,
        booking_date: '2026-02-30',
        amount: '-1.00',
        description: 'bad day',
      });
      expect(date.isError).toBe(true);
      await close();
    });

    it('unexpected failures are internal_error with no stack and no internals', async () => {
      const broken: ServiceCtx = {
        ...a,
        db: {
          transaction: () => Promise.reject(new Error('connection to 10.0.0.5 refused')),
        } as never,
      };
      const { call, close } = await connect(caller(broken));
      const r = await call('list_accounts');
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe('internal_error');
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/10\.0\.0\.5|refused|\bat \S+ \(|node_modules/);
      await close();
    });
  });

  it('categorise_transaction writes exactly one audit row per call, and the service alone writes none', async () => {
    const row = await manual(a, { description: 'Atomic', bookingDate: '2026-04-13' });
    const { call, close } = await connect(caller(a));
    await call('categorise_transaction', { transaction_id: row.id, category_id: food });
    const rows = (await audit(a)).filter((x) => x.targetId === row.id);
    expect(rows).toHaveLength(1);
    await close();
    // sanity: the service itself writes no audit rows
    const other = await manual(a, { description: 'No tool', bookingDate: '2026-04-14' });
    await categoriseTransaction(a, { id: other.id, categoryId: food });
    expect((await audit(a)).filter((x) => x.targetId === other.id)).toHaveLength(0);
  });
});
