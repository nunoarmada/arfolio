import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  addAssetValuation,
  categoriseTransaction,
  createAccount,
  createAsset,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  createRule,
  householdToday,
  recordAudit,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { auditLog } = schema;

/**
 * `onCommit` runs inside the service's own transaction, so a caller (the MCP tools) can write its
 * audit row atomically with the change: a throwing hook rolls the change back.
 */
describe('write services: onCommit hook', () => {
  let t: ServicesTestDb;
  let ctx: ServiceCtx;
  let accountId: string;
  let categoryId: string;
  let assetId: string;

  const auditRows = () =>
    withHousehold(ctx.db, ctx.householdId, (tx) => tx.select().from(auditLog));
  const audit = (action: string) => (tx: Parameters<typeof recordAudit>[0]) =>
    recordAudit(tx, ctx, { actor: 'mcp', action });

  beforeAll(async () => {
    t = await startServicesDb();
    await t.owner.insert(schema.user).values({ id: 'user-1', name: 'u', email: 'u@example.test' });
    ctx = await t.household();
    accountId = (await createAccount(ctx, { name: 'One', type: 'checking' })).id;
    const group = await createCategoryGroup(ctx, { name: 'Mine', kind: 'expense' });
    categoryId = (await createCategory(ctx, { groupId: group.id, name: 'Food' })).id;
    assetId = (await createAsset(ctx, { kind: 'real_estate', name: 'Flat' })).id;
  });
  afterAll(() => t.close());

  it('createManualTransaction passes the created row and commits with the hook', async () => {
    let seen: string | undefined;
    const row = await createManualTransaction(
      ctx,
      { accountId, bookingDate: '2026-04-10', amount: -100, description: 'Hooked' },
      {
        onCommit: async (tx, r) => {
          seen = r.id;
          await audit('transaction.create')(tx);
        },
      },
    );
    expect(seen).toBe(row.id);
    expect((await auditRows()).map((r) => r.action)).toContain('transaction.create');
  });

  it('a throwing hook rolls the write back', async () => {
    const before = (await auditRows()).length;
    await expect(
      createManualTransaction(
        ctx,
        { accountId, bookingDate: '2026-04-11', amount: -100, description: 'Rolled back' },
        {
          onCommit: async () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
    const rows = await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx.select().from(schema.transaction),
    );
    expect(rows.map((r) => r.rawDescription)).not.toContain('Rolled back');
    expect((await auditRows()).length).toBe(before);
  });

  it('categoriseTransaction, addAssetValuation and createRule call the hook with their result', async () => {
    const tx1 = await createManualTransaction(ctx, {
      accountId,
      bookingDate: '2026-04-12',
      amount: -500,
      description: 'Cat me',
    });
    let catId: string | undefined;
    await categoriseTransaction(
      ctx,
      { id: tx1.id, categoryId },
      {
        onCommit: async (_tx, r) => {
          catId = r.transaction.id;
        },
      },
    );
    expect(catId).toBe(tx1.id);

    let valued: string | undefined;
    await addAssetValuation(
      ctx,
      assetId,
      { asOf: '2026-04-01', value: 100_000 },
      {
        onCommit: async (_tx, r) => {
          valued = r.assetId;
        },
      },
    );
    expect(valued).toBe(assetId);

    let ruleId: string | undefined;
    const rule = await createRule(
      ctx,
      { name: 'R', categoryId, condition: { descriptionContains: 'x' } },
      {
        onCommit: async (_tx, r) => {
          ruleId = r.id;
        },
      },
    );
    expect(ruleId).toBe(rule.id);
  });
});

describe('householdToday', () => {
  let t: ServicesTestDb;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  it("returns the household's currency, time zone and local day", async () => {
    const ctx = await t.household({ currency: 'EUR' });
    await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx
        .update(schema.householdSettings)
        .set({ timezone: 'Pacific/Auckland' })
        .where(eq(schema.householdSettings.householdId, ctx.householdId)),
    );
    const r = await householdToday(ctx, new Date('2026-06-30T13:00:00Z'));
    expect(r).toEqual({ currency: 'EUR', timeZone: 'Pacific/Auckland', today: '2026-07-01' });
  });
});
