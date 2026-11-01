import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveAccount,
  createAccount,
  createGoal,
  createRule,
  getRule,
  createManualTransaction,
  deleteAccount,
  ForbiddenError,
  listAccounts,
  listAudit,
  listCategories,
  markTransfer,
  NotFoundError,
  seedCategoryTemplates,
  snapshotNetWorth,
  updateAccount,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { lockTransfers } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('accounts service', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household({ currency: 'USD' });
    b = await t.household();
  });
  afterAll(() => t.close());

  it('creates an account with defaults from the household currency', async () => {
    const acc = await createAccount(a, { name: 'Main', type: 'checking' });
    expect(acc).toMatchObject({
      name: 'Main',
      type: 'checking',
      currency: 'USD',
      openingBalance: 0,
      householdId: a.householdId,
    });
  });

  it('rejects invalid input with ValidationError', async () => {
    await expect(createAccount(a, { name: '', type: 'checking' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createAccount(a, { name: 'x', type: 'bogus' as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createAccount(a, { name: 'x', type: 'cash', openingBalance: 1.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('computes balance as opening + booked amounts after the opening date', async () => {
    const acc = await createAccount(a, {
      name: 'Balance',
      type: 'savings',
      openingBalance: 10_000,
      openingBalanceDate: '2026-01-10',
    });
    const row = (over: Partial<typeof schema.transaction.$inferInsert>, n: number) => ({
      householdId: a.householdId,
      accountId: acc.id,
      dedupeHash: `h${n}`,
      bookingDate: '2026-01-15',
      amount: 1_000,
      currency: 'USD',
      status: 'booked' as const,
      rawDescription: 'x',
      source: 'manual' as const,
      ...over,
    });
    await withHousehold(a.db, a.householdId, (tx) =>
      tx.insert(schema.transaction).values([
        row({ amount: 2_500 }, 1),
        row({ amount: -500 }, 2),
        row({ bookingDate: '2026-01-10', amount: 9_999 }, 3), // on the opening date: excluded
        row({ bookingDate: '2026-01-01', amount: 7_777 }, 4), // before: excluded
        row({ status: 'pending', amount: 4_242 }, 5), // pending: excluded
      ]),
    );
    const found = (await listAccounts(a)).find((x) => x.id === acc.id);
    expect(found?.balance).toBe(10_000 + 2_500 - 500);
  });

  it('counts every booked amount when there is no opening date, and zero for empty accounts', async () => {
    const empty = await createAccount(a, { name: 'Empty', type: 'cash', openingBalance: 300 });
    const found = (await listAccounts(a)).find((x) => x.id === empty.id);
    expect(found?.balance).toBe(300);
  });

  it('updates fields and keeps the currency fixed', async () => {
    const acc = await createAccount(a, { name: 'Old', type: 'card' });
    const updated = await updateAccount(a, acc.id, { name: 'New', includeInBudget: false });
    expect(updated).toMatchObject({ name: 'New', includeInBudget: false, currency: 'USD' });
    await expect(updateAccount(a, acc.id, { currency: 'EUR' } as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('keeps a credit limit only on cards', async () => {
    const card = await createAccount(a, { name: 'Limit card', type: 'card', creditLimit: 100_000 });
    expect(card.creditLimit).toBe(100_000);
    expect((await updateAccount(a, card.id, { creditLimit: 50_000 })).creditLimit).toBe(50_000);
    expect((await updateAccount(a, card.id, { creditLimit: null })).creditLimit).toBeNull();
    await updateAccount(a, card.id, { creditLimit: 50_000 });
    // Leaving the card type drops the limit.
    expect((await updateAccount(a, card.id, { type: 'checking' })).creditLimit).toBeNull();
    await expect(
      createAccount(a, { name: 'No', type: 'checking', creditLimit: 1_000 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateAccount(a, card.id, { creditLimit: 1_000 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      createAccount(a, { name: 'Neg', type: 'card', creditLimit: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('archives accounts and hides them unless asked', async () => {
    const acc = await createAccount(a, { name: 'ToArchive', type: 'other' });
    const archived = await archiveAccount(a, acc.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await listAccounts(a)).some((x) => x.id === acc.id)).toBe(false);
    expect((await listAccounts(a, { includeArchived: true })).some((x) => x.id === acc.id)).toBe(
      true,
    );
  });

  it('isolates households: another household gets NotFoundError and sees nothing', async () => {
    const acc = await createAccount(a, { name: 'Private', type: 'checking' });
    await expect(updateAccount(b, acc.id, { name: 'hack' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(archiveAccount(b, acc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAccount(b, 'not-a-uuid', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await listAccounts(b)).toEqual([]);
  });

  it('forbids every write for viewers but allows reads', async () => {
    const viewer = withRole(a, 'viewer');
    const acc = await createAccount(a, { name: 'ForViewer', type: 'checking' });
    await expect(createAccount(viewer, { name: 'x', type: 'cash' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(updateAccount(viewer, acc.id, { name: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(archiveAccount(viewer, acc.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAccounts(viewer)).length).toBeGreaterThan(0);
  });

  describe('deleteAccount', () => {
    const tx = (ctx: ServiceCtx) => ({
      rows: (accountId: string) =>
        withHousehold(ctx.db, ctx.householdId, (q) =>
          q.select().from(schema.transaction).where(eq(schema.transaction.accountId, accountId)),
        ),
      byId: async (id: string) =>
        (
          await withHousehold(ctx.db, ctx.householdId, (q) =>
            q.select().from(schema.transaction).where(eq(schema.transaction.id, id)),
          )
        )[0],
    });
    const manual = (ctx: ServiceCtx, accountId: string, amount: number, description = 'Row') =>
      createManualTransaction(ctx, { accountId, bookingDate: '2026-04-10', amount, description });

    beforeAll(async () => {
      await seedCategoryTemplates(a, 'en');
      // The audit row references the acting user.
      await t.owner
        .insert(schema.user)
        .values({ id: a.userId, name: 'u', email: 'u@example.test' })
        .onConflictDoNothing();
    });

    it('deletes the account with its transactions and balances', async () => {
      const acc = await createAccount(a, { name: 'Gone', type: 'checking' });
      await manual(a, acc.id, -500);
      await withHousehold(a.db, a.householdId, (q) =>
        q.insert(schema.balanceSnapshot).values({
          householdId: a.householdId,
          accountId: acc.id,
          asOf: '2026-04-10',
          balance: 100,
          currency: acc.currency,
          source: 'manual',
        }),
      );
      await deleteAccount(a, acc.id);
      expect((await listAccounts(a, { includeArchived: true })).some((x) => x.id === acc.id)).toBe(
        false,
      );
      expect(await tx(a).rows(acc.id)).toEqual([]);
      const balances = await withHousehold(a.db, a.householdId, (q) =>
        q.select().from(schema.balanceSnapshot).where(eq(schema.balanceSnapshot.accountId, acc.id)),
      );
      expect(balances).toEqual([]);
    });

    it('works on an archived account', async () => {
      const acc = await createAccount(a, { name: 'Archived then gone', type: 'other' });
      await archiveAccount(a, acc.id);
      await deleteAccount(a, acc.id);
      expect((await listAccounts(a, { includeArchived: true })).some((x) => x.id === acc.id)).toBe(
        false,
      );
    });

    it('returns the partner leg in another account to review, no longer a transfer', async () => {
      const transferCat = (await listCategories(a))
        .flatMap((g) => g.categories)
        .find((c) => c.templateKey === 'transfer.between_accounts')!.id;
      const gone = await createAccount(a, { name: 'Leg gone', type: 'checking' });
      const kept = await createAccount(a, { name: 'Leg kept', type: 'savings' });
      const out = await manual(a, gone.id, -2_000, 'Move out');
      const inn = await manual(a, kept.id, 2_000, 'Move in');
      await markTransfer(a, out.id, inn.id);
      await deleteAccount(a, gone.id);
      const partner = await tx(a).byId(inn.id);
      expect(partner).toMatchObject({ transferGroupId: null, needsReview: true });
      expect(partner!.categoryId).not.toBe(transferCat);
    });

    it('keeps goals and the hub setting but drops the reference', async () => {
      const acc = await createAccount(a, { name: 'Referenced', type: 'savings' });
      const goal = await createGoal(a, { name: 'Trip', accountId: acc.id });
      await withHousehold(a.db, a.householdId, (q) =>
        q
          .update(schema.householdSettings)
          .set({ hubAccountId: acc.id })
          .where(eq(schema.householdSettings.householdId, a.householdId)),
      );
      await deleteAccount(a, acc.id);
      const [g] = await withHousehold(a.db, a.householdId, (q) =>
        q.select().from(schema.goal).where(eq(schema.goal.id, goal.id)),
      );
      expect(g).toMatchObject({ accountId: null });
      const [settings] = await withHousehold(a.db, a.householdId, (q) =>
        q
          .select()
          .from(schema.householdSettings)
          .where(eq(schema.householdSettings.householdId, a.householdId)),
      );
      expect(settings!.hubAccountId).toBeNull();
    });

    it('a transfer paired concurrently is still unlinked: the delete waits for the pairing', async () => {
      const gone = await createAccount(a, { name: 'Race gone', type: 'checking' });
      const kept = await createAccount(a, { name: 'Race kept', type: 'savings' });
      const out = await manual(a, gone.id, -3_000, 'Race out');
      const inn = await manual(a, kept.id, 3_000, 'Race in');
      let paired!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((r) => (paired = r));
      const gate = new Promise<void>((r) => (release = r));
      // An automatic pairing (sync) holds the transfers lock and has linked both legs, uncommitted.
      const pairing = withHousehold(t.db, a.householdId, async (q) => {
        await lockTransfers(q, a.householdId);
        await q
          .update(schema.transaction)
          .set({ transferGroupId: crypto.randomUUID() })
          .where(inArray(schema.transaction.id, [out.id, inn.id]));
        paired();
        await gate;
      });
      await ready;
      const deleting = deleteAccount(a, gone.id).then(
        () => null,
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 300));
      release();
      await pairing;
      expect(await deleting).toBeNull();
      expect(await tx(a).byId(inn.id)).toMatchObject({ transferGroupId: null, needsReview: true });
    });

    it('a legacy transfer with both legs in the deleted account does not fail', async () => {
      const acc = await createAccount(a, { name: 'Both legs', type: 'checking' });
      const one = await manual(a, acc.id, -100, 'Leg one');
      const two = await manual(a, acc.id, 100, 'Leg two');
      const group = crypto.randomUUID();
      await withHousehold(a.db, a.householdId, (q) =>
        q
          .update(schema.transaction)
          .set({ transferGroupId: group })
          .where(eq(schema.transaction.accountId, acc.id)),
      );
      await deleteAccount(a, acc.id);
      expect(await tx(a).byId(one.id)).toBeUndefined();
      expect(await tx(a).byId(two.id)).toBeUndefined();
    });

    it('removes the bank link but keeps the connection', async () => {
      const acc = await createAccount(a, { name: 'Linked', type: 'checking' });
      const connectionId = crypto.randomUUID();
      await withHousehold(a.db, a.householdId, async (q) => {
        await q.insert(schema.connection).values({
          id: connectionId,
          householdId: a.householdId,
          provider: 'enablebanking',
          displayName: 'Bank',
          status: 'active',
          createdBy: a.userId,
        });
        await q.insert(schema.connectionAccount).values({
          householdId: a.householdId,
          connectionId,
          accountId: acc.id,
          externalUid: 'uid-1',
          externalKey: 'key-1',
          currency: acc.currency,
          name: 'Provider account',
        });
      });
      await deleteAccount(a, acc.id);
      const [links, connections] = await withHousehold(a.db, a.householdId, (q) =>
        Promise.all([
          q
            .select()
            .from(schema.connectionAccount)
            .where(eq(schema.connectionAccount.connectionId, connectionId)),
          q.select().from(schema.connection).where(eq(schema.connection.id, connectionId)),
        ]),
      );
      expect(links).toEqual([]);
      expect(connections).toHaveLength(1);
    });

    it('stored net-worth snapshots stop counting the deleted account', async () => {
      const c = await t.household({ currency: 'EUR' });
      await t.owner
        .insert(schema.user)
        .values({ id: c.userId, name: 'u', email: 'u@example.test' })
        .onConflictDoNothing();
      const acc = await createAccount(c, {
        name: 'Counted',
        type: 'savings',
        openingBalance: 50_000,
        openingBalanceDate: '2026-01-01',
      });
      const before = await snapshotNetWorth({ db: c.db }, c.householdId, '2026-02-01');
      expect(before.net).toBe(50_000);
      await deleteAccount(c, acc.id);
      const [stored] = await withHousehold(c.db, c.householdId, (q) =>
        q
          .select()
          .from(schema.netWorthSnapshot)
          .where(eq(schema.netWorthSnapshot.householdId, c.householdId)),
      );
      expect(stored!.net).toBe(0);
    });

    it('drops the account from rules, and disables a rule left with no account', async () => {
      const categoryId = (await listCategories(a)).flatMap((g) => g.categories)[0]!.id;
      const gone = await createAccount(a, { name: 'Ruled gone', type: 'checking' });
      const kept = await createAccount(a, { name: 'Ruled kept', type: 'checking' });
      const both = await createRule(a, {
        name: 'Both',
        condition: { descriptionContains: 'x', accountIds: [gone.id, kept.id] },
        categoryId,
      });
      const only = await createRule(a, {
        name: 'Only',
        condition: { descriptionContains: 'y', accountIds: [gone.id] },
        categoryId,
      });
      const other = await createRule(a, {
        name: 'Other',
        condition: { descriptionContains: 'z' },
        categoryId,
      });
      await deleteAccount(a, gone.id);
      expect(await getRule(a, both.id)).toMatchObject({
        enabled: true,
        condition: { descriptionContains: 'x', accountIds: [kept.id] },
      });
      // An empty accountIds would mean every account: the rule is switched off instead.
      expect(await getRule(a, only.id)).toMatchObject({ enabled: false });
      expect(await getRule(a, other.id)).toMatchObject({
        enabled: true,
        condition: { descriptionContains: 'z' },
      });
    });

    it('writes an account.delete audit row', async () => {
      const acc = await createAccount(a, { name: 'Audited', type: 'cash' });
      await deleteAccount(a, acc.id);
      const { items } = await listAudit(a, { limit: 5 });
      expect(items).toContainEqual(
        expect.objectContaining({
          action: 'account.delete',
          targetType: 'account',
          targetId: acc.id,
        }),
      );
    });

    it('refuses members and viewers and keeps the account', async () => {
      const acc = await createAccount(a, { name: 'Protected', type: 'checking' });
      await expect(deleteAccount(withRole(a, 'member'), acc.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(deleteAccount(withRole(a, 'viewer'), acc.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect((await listAccounts(a)).some((x) => x.id === acc.id)).toBe(true);
    });

    it('another household or a bad id is NotFoundError', async () => {
      const acc = await createAccount(a, { name: 'Not theirs', type: 'checking' });
      await expect(deleteAccount(b, acc.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteAccount(a, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
      expect((await listAccounts(a)).some((x) => x.id === acc.id)).toBe(true);
    });
  });
});
