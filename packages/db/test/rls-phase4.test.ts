import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db, type Tx } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

/** Drizzle wraps driver errors ("Failed query"); the Postgres message is on `cause`. */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  }
  throw new Error('expected the query to be rejected');
}

// Tables with a single `id` primary key; net_worth_snapshot has a composite key and gets its own
// household checks below.
const ID_TABLES = ['asset', 'asset_valuation', 'liability', 'liability_balance', 'goal'] as const;
const ALL_TABLES = [...ID_TABLES, 'net_worth_snapshot'] as const;

interface Seed {
  accountId: string;
  budgetLineId: string;
  assetId: string;
  valuationId: string;
  liabilityId: string;
  balanceId: string;
  goalId: string;
}

async function seed(tx: Tx, h: string): Promise<Seed> {
  const [account] = await tx
    .insert(schema.financialAccount)
    .values({ householdId: h, name: 'Main', type: 'checking' })
    .returning();
  const [budget] = await tx
    .insert(schema.budget)
    .values({ householdId: h, startMonth: '2026-01-01', name: '2026', createdBy: 'u1' })
    .returning();
  const [line] = await tx
    .insert(schema.budgetLine)
    .values({ householdId: h, budgetId: budget!.id, kind: 'saving', name: 'Save', position: 0 })
    .returning();
  const [asset] = await tx
    .insert(schema.asset)
    .values({ householdId: h, kind: 'real_estate', name: 'House', currency: 'EUR' })
    .returning();
  const [valuation] = await tx
    .insert(schema.assetValuation)
    .values({
      householdId: h,
      assetId: asset!.id,
      asOf: '2026-01-31',
      value: 25000000,
      method: 'manual',
    })
    .returning();
  const [liability] = await tx
    .insert(schema.liability)
    .values({
      householdId: h,
      kind: 'mortgage',
      name: 'Mortgage',
      currency: 'EUR',
      accountId: account!.id,
      assetId: asset!.id,
    })
    .returning();
  const [balance] = await tx
    .insert(schema.liabilityBalance)
    .values({
      householdId: h,
      liabilityId: liability!.id,
      asOf: '2026-01-31',
      balance: 15000000,
      source: 'manual',
    })
    .returning();
  await tx.insert(schema.netWorthSnapshot).values({
    householdId: h,
    month: '2026-01-01',
    assets: 25000000,
    liabilities: 15000000,
    net: 10000000,
    breakdown: { byKind: {}, foreignCount: 0 },
  });
  const [goal] = await tx
    .insert(schema.goal)
    .values({
      householdId: h,
      kind: 'generic',
      name: 'Holiday',
      accountId: account!.id,
      budgetLineId: line!.id,
    })
    .returning();
  return {
    accountId: account!.id,
    budgetLineId: line!.id,
    assetId: asset!.id,
    valuationId: valuation!.id,
    liabilityId: liability!.id,
    balanceId: balance!.id,
    goalId: goal!.id,
  };
}

describe('phase 4 schema (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    a = await withHousehold(db, 'hA', (tx) => seed(tx, 'hA'));
    b = await withHousehold(db, 'hB', (tx) => seed(tx, 'hB'));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  const idTables = () =>
    ({
      asset: [schema.asset, 'assetId', { name: 'x' }],
      asset_valuation: [schema.assetValuation, 'valuationId', { note: 'x' }],
      liability: [schema.liability, 'liabilityId', { name: 'x' }],
      liability_balance: [schema.liabilityBalance, 'balanceId', { note: 'x' }],
      goal: [schema.goal, 'goalId', { name: 'x' }],
    }) as const;

  // FORCE ROW LEVEL SECURITY is intentionally not used (repo convention, see 0001).
  it.each(ALL_TABLES)('%s has RLS enabled with a household_isolation policy', async (table) => {
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, (select count(*)::int from pg_policies p
          where p.tablename = c.relname and p.policyname = 'household_isolation') as policies
          from pg_class c where c.relname = ${table} and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]).toMatchObject({ rls: true, policies: 1 });
  });

  it.each(ALL_TABLES)(
    '%s: policy USING and WITH CHECK use the household setting',
    async (table) => {
      const expected = "(household_id = current_setting('app.household_id'::text, true))";
      const { rows } = await db.execute(
        sql`select qual, with_check from pg_policies
          where tablename = ${table} and policyname = 'household_isolation'`,
      );
      expect(rows).toEqual([{ qual: expected, with_check: expected }]);
    },
  );

  it.each(ALL_TABLES)('%s: no rows visible outside withHousehold', async (table) => {
    const { rows } = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`);
    expect(rows).toEqual([{ n: 0 }]);
  });

  it.each(ID_TABLES)('%s: moving an own row to another household is rejected', async (table) => {
    const [tbl, key] = idTables()[table];
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(tbl as unknown as PgTable)
          .set({ householdId: 'hB' } as never)
          .where(eq((tbl as unknown as { id: PgColumn }).id, a[key])),
      ),
    );
    expect(message).toMatch(/row-level security/i);
  });

  it.each(ID_TABLES)('%s: household A cannot see, update or delete B rows', async (table) => {
    const [tbl, key, patch] = idTables()[table];
    const t = tbl as unknown as PgTable;
    const idCol = (tbl as unknown as { id: PgColumn }).id;
    const bId = b[key];
    expect(
      await withHousehold(db, 'hA', (tx) => tx.select().from(t).where(eq(idCol, bId))),
    ).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx
        .update(t)
        .set(patch as never)
        .where(eq(idCol, bId))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withHousehold(db, 'hA', (tx) =>
      tx.delete(t).where(eq(idCol, bId)).returning(),
    );
    expect(deleted).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(idCol, bId))),
    ).toHaveLength(1);
  });

  it('net_worth_snapshot: A cannot see, update or delete B rows', async () => {
    const t = schema.netWorthSnapshot;
    const seen = await withHousehold(db, 'hA', (tx) =>
      tx.select().from(t).where(eq(t.householdId, 'hB')),
    );
    expect(seen).toEqual([]);
    const updated = await withHousehold(db, 'hA', (tx) =>
      tx.update(t).set({ net: 1 }).where(eq(t.householdId, 'hB')).returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withHousehold(db, 'hA', (tx) =>
      tx.delete(t).where(eq(t.householdId, 'hB')).returning(),
    );
    expect(deleted).toEqual([]);
    expect(
      await withHousehold(db, 'hB', (tx) => tx.select().from(t).where(eq(t.householdId, 'hB'))),
    ).toHaveLength(1);
  });

  it('net_worth_snapshot: WITH CHECK rejects a row claiming another household or a move', async () => {
    const insert = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.netWorthSnapshot).values({
          householdId: 'hB',
          month: '2026-02-01',
          assets: 0,
          liabilities: 0,
          net: 0,
          breakdown: { byKind: {}, foreignCount: 0 },
        }),
      ),
    );
    expect(insert).toMatch(/row-level security/i);
    const moved = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.netWorthSnapshot)
          .set({ householdId: 'hB' })
          .where(eq(schema.netWorthSnapshot.householdId, 'hA')),
      ),
    );
    expect(moved).toMatch(/row-level security/i);
  });

  it('keeps updated_at triggers on asset, liability and goal', async () => {
    const { rows } = await db.execute(
      sql`select event_object_table as t from information_schema.triggers
          where trigger_name in ('asset_set_updated_at', 'liability_set_updated_at',
                                 'goal_set_updated_at')
          order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual(['asset', 'goal', 'liability']);
  });

  describe('composite FKs reject cross-household links', () => {
    it('asset to another household account', async () => {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.asset).values({
            householdId: 'hA',
            kind: 'cash',
            name: 'x',
            currency: 'EUR',
            accountId: b.accountId,
          }),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });

    it('asset_valuation to another household asset', async () => {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.assetValuation).values({
            householdId: 'hA',
            assetId: b.assetId,
            asOf: '2026-03-31',
            value: 1,
            method: 'manual',
          }),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });

    it('liability to another household account or asset', async () => {
      const insertLiab = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.liability).values({
            householdId: 'hA',
            kind: 'loan',
            name: 'x',
            currency: 'EUR',
            ...over,
          } as never),
        );
      expect(await pgError(insertLiab({ accountId: b.accountId }))).toMatch(/foreign key/i);
      expect(await pgError(insertLiab({ assetId: b.assetId }))).toMatch(/foreign key/i);
    });

    it('liability_balance to another household liability', async () => {
      const message = await pgError(
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.liabilityBalance).values({
            householdId: 'hA',
            liabilityId: b.liabilityId,
            asOf: '2026-03-31',
            balance: 1,
            source: 'manual',
          }),
        ),
      );
      expect(message).toMatch(/foreign key/i);
    });

    it('goal to another household account or budget line', async () => {
      const insertGoal = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.goal).values({
            householdId: 'hA',
            kind: 'generic',
            name: 'x',
            ...over,
          } as never),
        );
      expect(await pgError(insertGoal({ accountId: b.accountId }))).toMatch(/foreign key/i);
      expect(await pgError(insertGoal({ budgetLineId: b.budgetLineId }))).toMatch(/foreign key/i);
    });
  });

  describe('uniqueness and checks', () => {
    const insertAsset = (over: Record<string, unknown>) =>
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.asset).values({
          householdId: 'hA',
          kind: 'vehicle',
          name: 'x',
          currency: 'EUR',
          ...over,
        } as never),
      );

    it('asset: kind check, currency required, depreciation 0..10000, defaults', async () => {
      expect(await pgError(insertAsset({ kind: 'boat' }))).toMatch(/check constraint/i);
      expect(await pgError(insertAsset({ depreciationBpsPerYear: -1 }))).toMatch(
        /check constraint/i,
      );
      expect(await pgError(insertAsset({ depreciationBpsPerYear: 10001 }))).toMatch(
        /check constraint/i,
      );
      expect(await pgError(insertAsset({ currency: null }))).toMatch(/not-null/i);
      const [ok] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.asset)
          .values({
            householdId: 'hA',
            kind: 'vehicle',
            name: 'Car',
            currency: 'EUR',
            depreciationBpsPerYear: 10000,
          })
          .returning(),
      );
      expect(ok).toMatchObject({ archived: false, position: 0, accountId: null, notes: null });
    });

    it('asset_valuation: unique (asset, as_of), value >= 0, method check', async () => {
      const put = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.assetValuation).values({
            householdId: 'hA',
            assetId: a.assetId,
            asOf: '2026-02-28',
            value: 100,
            method: 'manual',
            ...over,
          } as never),
        );
      await put({ value: 0 });
      expect(await pgError(put({}))).toMatch(/duplicate key/i);
      expect(await pgError(put({ asOf: '2026-04-30', value: -1 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ asOf: '2026-04-30', method: 'guess' }))).toMatch(
        /check constraint/i,
      );
      // Another household's asset may use the same date.
      await withHousehold(db, 'hB', (tx) =>
        tx.insert(schema.assetValuation).values({
          householdId: 'hB',
          assetId: b.assetId,
          asOf: '2026-02-28',
          value: 1,
          method: 'connector',
        }),
      );
    });

    it('liability: kind, rate 0..100000, term 1..600, principal and currency', async () => {
      const put = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.liability).values({
            householdId: 'hA',
            kind: 'loan',
            name: 'x',
            currency: 'EUR',
            ...over,
          } as never),
        );
      expect(await pgError(put({ kind: 'gift' }))).toMatch(/check constraint/i);
      expect(await pgError(put({ annualRateBps: -1 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ annualRateBps: 100001 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ termMonths: 0 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ termMonths: 601 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ principal: -1 }))).toMatch(/liability_principal_check/);
      expect(await pgError(put({ currency: null }))).toMatch(/not-null/i);
      const [ok] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.liability)
          .values({
            householdId: 'hA',
            kind: 'mortgage',
            name: 'Edge',
            currency: 'EUR',
            principal: 20000000,
            annualRateBps: 100000,
            termMonths: 600,
            startDate: '2026-01-01',
          })
          .returning(),
      );
      expect(ok).toMatchObject({ archived: false, position: 0, annualRateBps: 100000 });
    });

    it('liability_balance: unique (liability, as_of), balance >= 0, source check', async () => {
      const put = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.liabilityBalance).values({
            householdId: 'hA',
            liabilityId: a.liabilityId,
            asOf: '2026-02-28',
            balance: 100,
            source: 'schedule',
            ...over,
          } as never),
        );
      await put({ balance: 0 });
      expect(await pgError(put({}))).toMatch(/duplicate key/i);
      expect(await pgError(put({ asOf: '2026-04-30', balance: -1 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ asOf: '2026-04-30', source: 'guess' }))).toMatch(
        /check constraint/i,
      );
    });

    it('net_worth_snapshot: one per household and month, month must be the first day', async () => {
      const put = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.netWorthSnapshot).values({
            householdId: 'hA',
            month: '2026-05-01',
            assets: 0,
            liabilities: 0,
            net: 0,
            breakdown: {},
            ...over,
          } as never),
        );
      expect(await pgError(put({ month: '2026-01-01' }))).toMatch(/duplicate key/i);
      expect(await pgError(put({ month: '2026-05-31' }))).toMatch(/check constraint/i);
      // Net may be negative; another household may reuse the month.
      await put({ net: -500, liabilities: 500 });
      await withHousehold(db, 'hB', (tx) =>
        tx.insert(schema.netWorthSnapshot).values({
          householdId: 'hB',
          month: '2026-05-01',
          assets: 0,
          liabilities: 0,
          net: 0,
          breakdown: { byKind: {}, foreignCount: 0 },
        }),
      );
      const [row] = await withHousehold(db, 'hA', (tx) =>
        tx
          .select()
          .from(schema.netWorthSnapshot)
          .where(eq(schema.netWorthSnapshot.month, '2026-01-01')),
      );
      expect(row!.breakdown).toEqual({ byKind: {}, foreignCount: 0 });
      expect(row!.computedAt).toBeInstanceOf(Date);
    });

    it('goal: kind, target and contribution must be >= 0 when set', async () => {
      const put = (over: Record<string, unknown>) =>
        withHousehold(db, 'hA', (tx) =>
          tx.insert(schema.goal).values({
            householdId: 'hA',
            kind: 'emergency_fund',
            name: 'x',
            ...over,
          } as never),
        );
      expect(await pgError(put({ kind: 'dream' }))).toMatch(/check constraint/i);
      expect(await pgError(put({ targetAmount: -1 }))).toMatch(/check constraint/i);
      expect(await pgError(put({ monthlyContribution: -1 }))).toMatch(/check constraint/i);
      const [ok] = await withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.goal)
          .values({
            householdId: 'hA',
            kind: 'emergency_fund',
            name: 'Zero',
            targetAmount: 0,
            monthlyContribution: 0,
            targetDate: '2027-01-01',
          })
          .returning(),
      );
      expect(ok).toMatchObject({ archived: false, position: 0, accountId: null });
    });
  });

  describe('delete behaviour', () => {
    it('deleting an asset cascades valuations; linked liability keeps its row and household', async () => {
      const x = await withHousehold(db, 'hB', async (tx) => {
        const [asset] = await tx
          .insert(schema.asset)
          .values({ householdId: 'hB', kind: 'real_estate', name: 'Tmp', currency: 'EUR' })
          .returning();
        await tx.insert(schema.assetValuation).values({
          householdId: 'hB',
          assetId: asset!.id,
          asOf: '2026-06-30',
          value: 5,
          method: 'import',
        });
        const [liab] = await tx
          .insert(schema.liability)
          .values({
            householdId: 'hB',
            kind: 'mortgage',
            name: 'Tmp',
            currency: 'EUR',
            assetId: asset!.id,
          })
          .returning();
        return { asset: asset!, liab: liab! };
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.asset).where(eq(schema.asset.id, x.asset.id)),
      );
      const { rows } = await withHousehold(db, 'hB', (tx) =>
        tx.execute(
          sql`select count(*)::int as n from asset_valuation where asset_id = ${x.asset.id}`,
        ),
      );
      expect(rows[0]).toEqual({ n: 0 });
      const [liab] = await withHousehold(db, 'hB', (tx) =>
        tx.select().from(schema.liability).where(eq(schema.liability.id, x.liab.id)),
      );
      expect(liab).toMatchObject({ householdId: 'hB', assetId: null });
    });

    it('deleting a liability cascades its balances', async () => {
      const liabId = await withHousehold(db, 'hB', async (tx) => {
        const [l] = await tx
          .insert(schema.liability)
          .values({ householdId: 'hB', kind: 'card', name: 'Card', currency: 'EUR' })
          .returning();
        await tx.insert(schema.liabilityBalance).values({
          householdId: 'hB',
          liabilityId: l!.id,
          asOf: '2026-06-30',
          balance: 5,
          source: 'import',
        });
        return l!.id;
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.liability).where(eq(schema.liability.id, liabId)),
      );
      const { rows } = await withHousehold(db, 'hB', (tx) =>
        tx.execute(
          sql`select count(*)::int as n from liability_balance where liability_id = ${liabId}`,
        ),
      );
      expect(rows[0]).toEqual({ n: 0 });
    });

    it('deleting an account nulls asset, liability and goal references only', async () => {
      const x = await withHousehold(db, 'hB', async (tx) => {
        const [acc] = await tx
          .insert(schema.financialAccount)
          .values({ householdId: 'hB', name: 'Tmp', type: 'savings' })
          .returning();
        const [asset] = await tx
          .insert(schema.asset)
          .values({
            householdId: 'hB',
            kind: 'cash',
            name: 'Tmp',
            currency: 'EUR',
            accountId: acc!.id,
          })
          .returning();
        const [liab] = await tx
          .insert(schema.liability)
          .values({
            householdId: 'hB',
            kind: 'loan',
            name: 'Tmp',
            currency: 'EUR',
            accountId: acc!.id,
          })
          .returning();
        const [goal] = await tx
          .insert(schema.goal)
          .values({ householdId: 'hB', kind: 'generic', name: 'Tmp', accountId: acc!.id })
          .returning();
        return { acc: acc!, asset: asset!, liab: liab!, goal: goal! };
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.financialAccount).where(eq(schema.financialAccount.id, x.acc.id)),
      );
      const read = (table: PgTable, idCol: PgColumn, id: string) =>
        withHousehold(db, 'hB', async (tx) => {
          const [r] = await tx.select().from(table).where(eq(idCol, id));
          return r;
        });
      expect(await read(schema.asset, schema.asset.id, x.asset.id)).toMatchObject({
        householdId: 'hB',
        accountId: null,
      });
      expect(await read(schema.liability, schema.liability.id, x.liab.id)).toMatchObject({
        householdId: 'hB',
        accountId: null,
      });
      expect(await read(schema.goal, schema.goal.id, x.goal.id)).toMatchObject({
        householdId: 'hB',
        accountId: null,
      });
    });

    it('deleting a budget line nulls goal.budget_line_id and keeps the goal', async () => {
      const x = await withHousehold(db, 'hB', async (tx) => {
        const [line] = await tx
          .insert(schema.budgetLine)
          .values({
            householdId: 'hB',
            budgetId: (await tx.select().from(schema.budget))[0]!.id,
            kind: 'saving',
            name: 'Tmp',
            position: 8,
          })
          .returning();
        const [goal] = await tx
          .insert(schema.goal)
          .values({ householdId: 'hB', kind: 'generic', name: 'Tmp', budgetLineId: line!.id })
          .returning();
        return { line: line!, goal: goal! };
      });
      await withHousehold(db, 'hB', (tx) =>
        tx.delete(schema.budgetLine).where(eq(schema.budgetLine.id, x.line.id)),
      );
      const [after] = await withHousehold(db, 'hB', (tx) =>
        tx.select().from(schema.goal).where(eq(schema.goal.id, x.goal.id)),
      );
      expect(after).toMatchObject({ householdId: 'hB', budgetLineId: null });
    });
  });
});
