import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  budgetMonthView,
  listBudgets,
  listGoals,
  netWorthHistory,
  type ServiceCtx,
} from '../src/index.js';
import { DemoSeedError, seedDemoHousehold } from '../src/demo/seed.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const OPTS = { months: 12, seed: 7, now: NOW } as const;

describe('demo seed', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  /** Row counts and amount sums of everything the seed writes, read as the table owner. */
  async function fingerprint(householdId: string): Promise<Record<string, unknown>> {
    const one = async (query: ReturnType<typeof sql>): Promise<unknown> => {
      const res = await t.owner.execute(query);
      return (res.rows as unknown[])[0];
    };
    const h = householdId;
    return {
      accounts: await one(
        sql`select count(*)::int n, string_agg(name || ':' || opening_balance, '|' order by name) names from financial_account where household_id = ${h}`,
      ),
      transactions: await one(
        sql`select count(*)::int n, sum(amount)::bigint total, count(distinct category_id)::int cats, min(booking_date)::text first, max(booking_date)::text last, string_agg(distinct raw_description, '|') descriptions from "transaction" where household_id = ${h}`,
      ),
      budgets: await one(
        sql`select (select count(*)::int from budget where household_id = ${h}) budgets, (select count(*)::int from budget_line where household_id = ${h}) lines, (select coalesce(sum(amount), 0)::bigint from budget_amount where household_id = ${h}) planned`,
      ),
      goals: await one(
        sql`select count(*)::int n, coalesce(sum(target_amount), 0)::bigint target from goal where household_id = ${h}`,
      ),
      assets: await one(
        sql`select (select count(*)::int from asset where household_id = ${h}) assets, (select coalesce(sum(value), 0)::bigint from asset_valuation where household_id = ${h}) valuations, (select count(*)::int from liability where household_id = ${h}) liabilities`,
      ),
      snapshots: await one(
        sql`select count(*)::int n, sum(net)::bigint net from net_worth_snapshot where household_id = ${h}`,
      ),
    };
  }

  it('seeding two households with the same seed yields identical counts and sums', async () => {
    const a = await t.household({ locale: 'en' });
    const b = await t.household({ locale: 'en' });
    await seedDemoHousehold(t.db, { householdId: a.householdId, locale: 'en', ...OPTS });
    await seedDemoHousehold(t.db, { householdId: b.householdId, locale: 'en', ...OPTS });

    const bank = await t.owner.execute(
      sql`select string_agg(distinct institution_name, '|') names from financial_account where household_id = ${a.householdId}`,
    );
    expect((bank.rows as Array<{ names: string }>)[0]!.names).toBe('Example Bank');

    const fa = await fingerprint(a.householdId);
    expect(fa).toEqual(await fingerprint(b.householdId));
    // A non-trivial dataset: the equality above would also hold for two empty households.
    expect(fa).toMatchObject({
      transactions: { n: expect.any(Number) },
      snapshots: { n: 12 },
    });
    expect((fa.transactions as { n: number }).n).toBeGreaterThan(400);
  });

  it('a different seed changes the amounts', async () => {
    const a = await t.household({ locale: 'en' });
    const b = await t.household({ locale: 'en' });
    await seedDemoHousehold(t.db, { householdId: a.householdId, locale: 'en', ...OPTS });
    await seedDemoHousehold(t.db, {
      householdId: b.householdId,
      locale: 'en',
      ...OPTS,
      seed: 8,
    });
    const total = async (h: string) => (await fingerprint(h)).transactions as { total: string };
    expect((await total(a.householdId)).total).not.toBe((await total(b.householdId)).total);
  });

  it('every row carries the given householdId and references nothing of another household', async () => {
    const target = await t.household({ locale: 'en' });
    const bystander = await t.household({ locale: 'en' });
    await seedDemoHousehold(t.db, {
      householdId: bystander.householdId,
      locale: 'en',
      ...OPTS,
      months: 2,
    });
    const before = await fingerprint(bystander.householdId);
    await seedDemoHousehold(t.db, { householdId: target.householdId, locale: 'en', ...OPTS });
    expect(await fingerprint(bystander.householdId)).toEqual(before);

    // Cross-household references, joined through the parent: none may exist.
    const crossing = await t.owner.execute(sql`
      select
        (select count(*)::int from "transaction" x join financial_account p on p.id = x.account_id where p.household_id <> x.household_id) tx_account,
        (select count(*)::int from "transaction" x join category p on p.id = x.category_id where p.household_id <> x.household_id) tx_category,
        (select count(*)::int from budget_line x join budget p on p.id = x.budget_id where p.household_id <> x.household_id) line_budget,
        (select count(*)::int from budget_amount x join budget_line p on p.id = x.budget_line_id where p.household_id <> x.household_id) amount_line,
        (select count(*)::int from goal x join financial_account p on p.id = x.account_id where p.household_id <> x.household_id) goal_account,
        (select count(*)::int from asset_valuation x join asset p on p.id = x.asset_id where p.household_id <> x.household_id) valuation_asset,
        (select count(*)::int from liability x join asset p on p.id = x.asset_id where p.household_id <> x.household_id) liability_asset
    `);
    expect((crossing.rows as Array<Record<string, number>>)[0]).toEqual({
      tx_account: 0,
      tx_category: 0,
      line_budget: 0,
      amount_line: 0,
      goal_account: 0,
      valuation_asset: 0,
      liability_asset: 0,
    });
    // Rows of the target household exist in every data table the seed fills.
    for (const table of [
      'financial_account',
      '"transaction"',
      'budget_line',
      'goal',
      'asset',
      'liability',
      'net_worth_snapshot',
    ]) {
      const res = await t.owner.execute(
        sql`select count(*)::int n from ${sql.raw(table)} where household_id = ${target.householdId}`,
      );
      expect((res.rows as Array<{ n: number }>)[0]!.n, table).toBeGreaterThan(0);
    }
  });

  it('refuses a household that already has transactions unless forced', async () => {
    const ctx = await t.household({ locale: 'en' });
    await seedDemoHousehold(t.db, {
      householdId: ctx.householdId,
      locale: 'en',
      ...OPTS,
      months: 2,
    });
    await expect(
      seedDemoHousehold(t.db, { householdId: ctx.householdId, locale: 'en', ...OPTS, months: 2 }),
    ).rejects.toBeInstanceOf(DemoSeedError);
    await expect(
      seedDemoHousehold(t.db, {
        householdId: ctx.householdId,
        locale: 'en',
        ...OPTS,
        months: 2,
        force: true,
      }),
    ).resolves.toBeUndefined();
  });

  describe('a seeded pt-PT household', () => {
    let ctx: ServiceCtx;
    beforeAll(async () => {
      ctx = await t.household({ locale: 'pt-PT', currency: 'EUR' });
      await seedDemoHousehold(t.db, { householdId: ctx.householdId, locale: 'pt-PT', ...OPTS });
    });

    it('uses the household categories, with groceries over budget and restaurants near the limit', async () => {
      const [budget] = await listBudgets(ctx);
      expect(budget).toBeDefined();
      // The previous, complete month: the budget starts 11 months before the current one.
      const view = await budgetMonthView(ctx, budget!.id, 11);
      const byName = new Map(view.lines.map((l) => [l.name, l]));
      expect(byName.get('Supermercado')!.percent).toBeGreaterThan(100);
      const restaurants = byName.get('Restaurantes e cafés')!.percent!;
      expect(restaurants).toBeGreaterThanOrEqual(85);
      expect(restaurants).toBeLessThanOrEqual(100);
    });

    it('has a partially funded goal, a property with its mortgage and a rising net worth', async () => {
      const goals = await listGoals(ctx, { now: NOW });
      expect(goals).toHaveLength(1);
      expect(goals[0]!.saved).toBeGreaterThan(0);
      expect(goals[0]!.saved).toBeLessThan(goals[0]!.target!);

      const kinds = await t.owner.execute(sql`
        select (select kind from asset where household_id = ${ctx.householdId}) asset_kind,
               (select kind from liability where household_id = ${ctx.householdId}) liability_kind
      `);
      expect((kinds.rows as unknown[])[0]).toEqual({
        asset_kind: 'real_estate',
        liability_kind: 'mortgage',
      });

      const history = await netWorthHistory(
        ctx,
        { from: '2025-11-01', to: '2026-10-31' },
        { now: NOW },
      );
      expect(history).toHaveLength(12);
      expect(history.at(-1)!.net).toBeGreaterThan(history[0]!.net);
      // Rising: no month ends lower than three months earlier.
      history.forEach((row, i) => {
        if (i >= 3) expect(row.net).toBeGreaterThanOrEqual(history[i - 3]!.net);
      });
    });

    it('sets the hub account, plans the monthly savings and holds a few investments', async () => {
      const hub = await t.owner.execute(sql`
        select a.name from household_settings s join financial_account a on a.id = s.hub_account_id
        where s.household_id = ${ctx.householdId}`);
      expect((hub.rows as Array<{ name: string }>)[0]?.name).toBe('Conta à ordem');
      const saving = await t.owner.execute(sql`
        select count(*)::int n from budget_line where household_id = ${ctx.householdId} and kind = 'saving'`);
      expect((saving.rows as Array<{ n: number }>)[0]!.n).toBe(1);
      const holdings = await t.owner.execute(sql`
        select count(*)::int n, sum(value_minor)::bigint value, sum(cost_minor)::bigint cost
        from position_snapshot where household_id = ${ctx.householdId}`);
      const row = (holdings.rows as Array<{ n: number; value: string; cost: string }>)[0]!;
      expect(row.n).toBe(3);
      expect(Number(row.value)).toBeGreaterThan(Number(row.cost));
    });

    it('uses only fictional names and specimen IBAN endings', async () => {
      const res = await t.owner.execute(sql`
        select string_agg(distinct institution_name, '|') institutions, string_agg(distinct iban_last4, '|' order by iban_last4) ibans
        from financial_account where household_id = ${ctx.householdId}`);
      const row = (res.rows as Array<{ institutions: string; ibans: string }>)[0]!;
      expect(row.institutions).toBe('Banco Exemplo');
      // Last four characters of the specimen IBANs DE89370400440532013000 and PT50000201231234567890154.
      for (const last4 of row.ibans.split('|')) expect(['0154', '3000']).toContain(last4);
    });
  });
});
