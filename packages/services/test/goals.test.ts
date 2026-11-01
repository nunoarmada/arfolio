import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveGoal,
  createAccount,
  createBudget,
  createCategory,
  createCategoryGroup,
  createGoal,
  emergencyFundAverage,
  ForbiddenError,
  linkCategories,
  listGoals,
  NotFoundError,
  setLineAmounts,
  updateGoal,
  upsertBudgetLine,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { transaction, householdSettings, goal } = schema;
const NOW = new Date('2026-06-15T10:00:00Z');
const flat = (n: number): number[] => Array.from({ length: 12 }, () => n);

describe('goals', () => {
  let t: ServicesTestDb;
  let hash = 0;
  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world(): Promise<ServiceCtx> {
    const ctx = await t.household({ currency: 'EUR' });
    await t.owner
      .update(householdSettings)
      .set({ timezone: 'UTC' })
      .where(eq(householdSettings.householdId, ctx.householdId));
    return ctx;
  }
  const spend = (
    ctx: ServiceCtx,
    accountId: string,
    categoryId: string,
    date: string,
    amount: number,
  ) =>
    t.owner.insert(transaction).values({
      householdId: ctx.householdId,
      accountId,
      dedupeHash: `g${(hash += 1)}`,
      bookingDate: date,
      amount,
      currency: 'EUR',
      status: 'booked',
      rawDescription: 'x',
      source: 'manual',
      categoryId,
    });
  const createdAt = (id: string, iso: string) =>
    t.owner
      .update(goal)
      .set({ createdAt: new Date(iso) })
      .where(eq(goal.id, id));

  /** A 2026 budget with a saving line (20 000 a month) fed by one category, and an expense line. */
  async function budgetWorld() {
    const ctx = await world();
    const acc = await createAccount(ctx, { name: 'Main', type: 'checking', openingBalance: 0 });
    const gSave = await createCategoryGroup(ctx, { name: 'Saving', kind: 'saving' });
    const gExp = await createCategoryGroup(ctx, { name: 'Home', kind: 'expense' });
    const pot = await createCategory(ctx, { groupId: gSave.id, name: 'Pot' });
    const food = await createCategory(ctx, { groupId: gExp.id, name: 'Food' });
    const budget = await createBudget(ctx, { startMonth: '2026-01-01' });
    const saveLine = await upsertBudgetLine(ctx, budget.id, {
      kind: 'saving',
      name: 'Holiday pot',
    });
    await setLineAmounts(ctx, saveLine.id, flat(20_000));
    await linkCategories(ctx, saveLine.id, [pot.id]);
    const foodLine = await upsertBudgetLine(ctx, budget.id, { kind: 'expense', name: 'Food' });
    await setLineAmounts(ctx, foodLine.id, flat(100_000));
    await linkCategories(ctx, foodLine.id, [food.id]);
    return { ctx, acc, pot: pot.id, saveLine, foodLine };
  }

  it('creates, updates and archives; validates links and input; viewers only read', async () => {
    const ctx = await world();
    const other = await world();
    const foreign = await createAccount(other, { name: 'Theirs', type: 'savings' });
    const acc = await createAccount(ctx, { name: 'Pot', type: 'savings' });
    const g = await createGoal(ctx, {
      name: ' Holiday ',
      targetAmount: 100_000,
      accountId: acc.id,
    });
    expect(g).toMatchObject({
      name: 'Holiday',
      kind: 'generic',
      accountId: acc.id,
      archived: false,
    });
    await expect(createGoal(ctx, { name: 'x', accountId: foreign.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createGoal(ctx, { name: 'x', budgetLineId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(createGoal(ctx, { name: 'x', targetAmount: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createGoal(ctx, { name: 'x', kind: 'dream' as never })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const upd = await updateGoal(ctx, g.id, {
      name: 'Trip',
      monthlyContribution: 5_000,
      accountId: null,
    });
    expect(upd).toMatchObject({ name: 'Trip', monthlyContribution: 5_000, accountId: null });
    await expect(updateGoal(other, g.id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);

    const viewer = withRole(ctx, 'viewer');
    expect(await listGoals(viewer, { now: NOW })).toHaveLength(1);
    await expect(createGoal(viewer, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateGoal(viewer, g.id, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(archiveGoal(viewer, g.id)).rejects.toBeInstanceOf(ForbiddenError);

    await archiveGoal(ctx, g.id);
    expect(await listGoals(ctx, { now: NOW })).toEqual([]);
    expect(await listGoals(ctx, { now: NOW, includeArchived: true })).toHaveLength(1);
  });

  it('a goal linked to an account has saved = that account balance today', async () => {
    const ctx = await world();
    const acc = await createAccount(ctx, { name: 'Pot', type: 'savings', openingBalance: 40_000 });
    await createGoal(ctx, {
      name: 'Car',
      targetAmount: 100_000,
      accountId: acc.id,
      monthlyContribution: 10_000,
    });
    const [g] = await listGoals(ctx, { now: NOW });
    expect(g).toMatchObject({
      saved: 40_000,
      target: 100_000,
      contribution: 10_000,
      projection: { remaining: 60_000, months: 6, expectedDate: '2026-12-01', progressBps: 4_000 },
    });
  });

  it('counts the linked account even when it is left out of net worth', async () => {
    const ctx = await world();
    const acc = await createAccount(ctx, {
      name: 'Pot',
      type: 'savings',
      openingBalance: 12_300,
      includeInNetWorth: false,
    });
    await createGoal(ctx, { name: 'Ring', targetAmount: 50_000, accountId: acc.id });
    expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(12_300);
  });

  it('a credit card saves nothing, whatever its balance', async () => {
    const ctx = await world();
    const card = await createAccount(ctx, { name: 'Card', type: 'card', openingBalance: 98_305 });
    await createGoal(ctx, { name: 'Trip', targetAmount: 50_000, accountId: card.id });
    expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(0);
  });

  it('a goal linked to a saving line sums its actuals from the creation month to this month', async () => {
    const { ctx, acc, pot, saveLine } = await budgetWorld();
    const g = await createGoal(ctx, {
      name: 'Holiday',
      targetAmount: 100_000,
      budgetLineId: saveLine.id,
    });
    await createdAt(g.id, '2026-03-10T09:00:00Z');
    await spend(ctx, acc.id, pot, '2026-01-20', -1_000); // before the goal existed
    await spend(ctx, acc.id, pot, '2026-02-28', -2_000);
    await spend(ctx, acc.id, pot, '2026-03-01', -5_000); // creation month counts in full
    await spend(ctx, acc.id, pot, '2026-04-10', -10_000);
    await spend(ctx, acc.id, pot, '2026-06-14', -7_500);
    await spend(ctx, acc.id, pot, '2026-07-02', -9_999); // a future month: not yet
    const [view] = await listGoals(ctx, { now: NOW });
    expect(view).toMatchObject({
      saved: 22_500,
      contribution: 20_000, // the line's planned amount this month
      projection: { remaining: 77_500, months: 4, expectedDate: '2026-10-01', progressBps: 2_250 },
    });
  });

  it('never reports a negative saved amount when refunds exceed contributions', async () => {
    const { ctx, acc, pot, saveLine } = await budgetWorld();
    const g = await createGoal(ctx, {
      name: 'Holiday',
      targetAmount: 100_000,
      budgetLineId: saveLine.id,
    });
    await createdAt(g.id, '2026-06-01T09:00:00Z');
    await spend(ctx, acc.id, pot, '2026-06-02', 5_000); // a net withdrawal from the pot
    const [view] = await listGoals(ctx, { now: new Date('2026-06-15T10:00:00Z') });
    expect(view).toMatchObject({ saved: 0, projection: { progressBps: 0, remaining: 100_000 } });
  });

  it('an explicit monthly contribution overrides the budget line plan', async () => {
    const { ctx, saveLine } = await budgetWorld();
    await createGoal(ctx, {
      name: 'Holiday',
      targetAmount: 100_000,
      budgetLineId: saveLine.id,
      monthlyContribution: 50_000,
    });
    const [view] = await listGoals(ctx, { now: NOW });
    expect(view!.contribution).toBe(50_000);
    expect(view!.projection.months).toBe(2);
  });

  it('a goal with no link saves nothing; one without a target has no projection', async () => {
    const ctx = await world();
    await createGoal(ctx, { name: 'Someday' });
    const [view] = await listGoals(ctx, { now: NOW });
    expect(view).toMatchObject({
      saved: 0,
      target: null,
      contribution: 0,
      projection: { remaining: 0, months: null, expectedDate: null, progressBps: null },
    });
  });

  it('the emergency fund target is the current budget average planned expense times the months', async () => {
    const { ctx, acc } = await budgetWorld();
    await createGoal(ctx, {
      kind: 'emergency_fund',
      name: 'Safety net',
      targetAmount: 1,
      accountId: acc.id,
    });
    const [six] = await listGoals(ctx, { now: NOW });
    expect(six).toMatchObject({ target: 600_000, projection: { remaining: 600_000 } });
    // The form's average is the same budget's: average x months is the card's target.
    expect(await emergencyFundAverage(ctx, { now: NOW })).toBe(100_000);
    expect((await emergencyFundAverage(ctx, { now: NOW }))! * 6).toBe(six!.target);
    expect(await emergencyFundAverage(ctx, { now: new Date('2028-02-01T00:00:00Z') })).toBeNull();
    await t.owner
      .update(householdSettings)
      .set({ emergencyFundMonths: 3 })
      .where(eq(householdSettings.householdId, ctx.householdId));
    const [three] = await listGoals(ctx, { now: NOW });
    expect(three!.target).toBe(300_000);
    // outside the budget's twelve months there is no current budget: the stored target stands
    const [later] = await listGoals(ctx, { now: new Date('2028-02-01T00:00:00Z') });
    expect(later!.target).toBe(1);
  });

  describe('saved baseline ("already saved")', () => {
    it('an unlinked goal has saved = its baseline; the date defaults to today in the household calendar', async () => {
      const ctx = await world();
      const g = await createGoal(ctx, {
        name: 'Bike',
        targetAmount: 100_000,
        savedBaseline: 30_000,
      });
      expect(g.savedBaseline).toBe(30_000);
      expect(g.savedBaselineDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((await listGoals(ctx, { now: NOW }))[0]).toMatchObject({
        saved: 30_000,
        projection: { remaining: 70_000 },
      });
      // clearing the amount clears its date
      expect(await updateGoal(ctx, g.id, { savedBaseline: null })).toMatchObject({
        savedBaseline: null,
        savedBaselineDate: null,
      });
      await expect(createGoal(ctx, { name: 'x', savedBaseline: -1 })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        createGoal(ctx, { name: 'x', savedBaselineDate: '2026-01-01' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('the database refuses a negative baseline or a baseline without its date', async () => {
      const ctx = await world();
      const row = { householdId: ctx.householdId, kind: 'generic' as const, name: 'x' };
      await expect(
        t.owner.insert(goal).values({ ...row, savedBaseline: -1, savedBaselineDate: '2026-01-01' }),
      ).rejects.toThrow();
      await expect(t.owner.insert(goal).values({ ...row, savedBaseline: 5 })).rejects.toThrow();
    });

    it('a saving-line goal is its baseline plus the actuals from the month after the baseline date', async () => {
      const { ctx, acc, pot, saveLine } = await budgetWorld();
      const g = await createGoal(ctx, {
        name: 'Holiday',
        targetAmount: 200_000,
        budgetLineId: saveLine.id,
        savedBaseline: 50_000,
        savedBaselineDate: '2026-03-10',
      });
      await createdAt(g.id, '2026-01-05T09:00:00Z');
      await spend(ctx, acc.id, pot, '2026-02-10', -1_000); // before the baseline
      await spend(ctx, acc.id, pot, '2026-03-20', -5_000); // the baseline month: already in it
      await spend(ctx, acc.id, pot, '2026-04-10', -10_000);
      await spend(ctx, acc.id, pot, '2026-06-14', -7_500);
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(67_500);
    });

    it('a withdrawal after the baseline lowers saved, never below zero', async () => {
      const { ctx, acc, pot, saveLine } = await budgetWorld();
      const g = await createGoal(ctx, {
        name: 'Holiday',
        budgetLineId: saveLine.id,
        savedBaseline: 3_000,
        savedBaselineDate: '2026-04-30',
      });
      await spend(ctx, acc.id, pot, '2026-05-02', 2_000);
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(1_000);
      await spend(ctx, acc.id, pot, '2026-05-03', 2_000);
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(0);
      void g;
    });

    it('an account-linked goal ignores the baseline: the account balance is what is saved', async () => {
      const ctx = await world();
      const acc = await createAccount(ctx, {
        name: 'Pot',
        type: 'savings',
        openingBalance: 40_000,
      });
      await createGoal(ctx, { name: 'Car', accountId: acc.id, savedBaseline: 99_999 });
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(40_000);
    });

    it('an account-linked goal never shows a negative saved amount', async () => {
      const ctx = await world();
      const acc = await createAccount(ctx, {
        name: 'Overdrawn',
        type: 'checking',
        openingBalance: -5_000,
      });
      await createGoal(ctx, { name: 'Car', targetAmount: 100_000, accountId: acc.id });
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(0);
    });

    it('an account in another currency than the household has no value for a goal', async () => {
      const ctx = await world();
      const acc = await createAccount(ctx, {
        name: 'Dollars',
        type: 'savings',
        currency: 'USD',
        openingBalance: 40_000,
      });
      await createGoal(ctx, { name: 'Car', targetAmount: 100_000, accountId: acc.id });
      expect((await listGoals(ctx, { now: NOW }))[0]!.saved).toBe(0);
    });

    it("re-linking to next year's line keeps what the old line saved (rolled into the baseline)", async () => {
      const { ctx, acc, pot, saveLine } = await budgetWorld();
      const g = await createGoal(ctx, { name: 'Holiday', budgetLineId: saveLine.id });
      await createdAt(g.id, '2026-01-05T09:00:00Z');
      await spend(ctx, acc.id, pot, '2026-02-10', -10_000);
      await spend(ctx, acc.id, pot, '2026-11-10', -20_000);
      const next = await createBudget(ctx, { startMonth: '2027-01-01' });
      const nextLine = await upsertBudgetLine(ctx, next.id, {
        kind: 'saving',
        name: 'Holiday pot',
      });
      await linkCategories(ctx, nextLine.id, [pot]);
      await spend(ctx, acc.id, pot, '2027-01-08', -4_000);
      const jan = new Date('2027-01-15T10:00:00Z');
      expect((await listGoals(ctx, { now: jan }))[0]!.saved).toBe(30_000);

      const relinked = await updateGoal(ctx, g.id, { budgetLineId: nextLine.id }, { now: jan });
      expect(relinked).toMatchObject({ savedBaseline: 30_000, savedBaselineDate: '2026-12-31' });
      // January of the new year counts on top of the old year's total
      expect((await listGoals(ctx, { now: jan }))[0]!.saved).toBe(34_000);
    });

    it('unlinking keeps the saved amount as the baseline; an explicit baseline in the same change wins', async () => {
      const { ctx, acc, pot, saveLine } = await budgetWorld();
      const a = await createGoal(ctx, { name: 'A', budgetLineId: saveLine.id });
      const b = await createGoal(ctx, { name: 'B', budgetLineId: saveLine.id });
      for (const id of [a.id, b.id]) await createdAt(id, '2026-01-05T09:00:00Z');
      await spend(ctx, acc.id, pot, '2026-03-10', -12_000);
      expect(await updateGoal(ctx, a.id, { budgetLineId: null }, { now: NOW })).toMatchObject({
        savedBaseline: 12_000,
        savedBaselineDate: '2026-06-15',
      });
      expect(
        await updateGoal(
          ctx,
          b.id,
          { budgetLineId: null, savedBaseline: 1, savedBaselineDate: '2026-06-01' },
          { now: NOW },
        ),
      ).toMatchObject({ savedBaseline: 1, savedBaselineDate: '2026-06-01' });
      const saved = new Map((await listGoals(ctx, { now: NOW })).map((g) => [g.name, g.saved]));
      expect([saved.get('A'), saved.get('B')]).toEqual([12_000, 1]);
    });
  });

  describe('one emergency fund per household', () => {
    const codeOf = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).code;
    };

    it('rejects a second emergency fund on create, and archiving the first frees the slot', async () => {
      const ctx = await world();
      const first = await createGoal(ctx, { kind: 'emergency_fund', name: 'Safety net' });
      expect(await codeOf(createGoal(ctx, { kind: 'emergency_fund', name: 'Other' }))).toBe(
        'emergency_fund_exists',
      );
      // other kinds and other households are unaffected
      await createGoal(ctx, { kind: 'generic', name: 'Holiday' });
      await createGoal(await world(), { kind: 'emergency_fund', name: 'Theirs' });

      await archiveGoal(ctx, first.id);
      const second = await createGoal(ctx, { kind: 'emergency_fund', name: 'Other' });
      expect(second.archived).toBe(false);
    });

    it('rejects turning a goal into a second emergency fund, but lets the fund itself change', async () => {
      const ctx = await world();
      const fund = await createGoal(ctx, { kind: 'emergency_fund', name: 'Safety net' });
      const trip = await createGoal(ctx, { name: 'Trip' });
      expect(await codeOf(updateGoal(ctx, trip.id, { kind: 'emergency_fund' }))).toBe(
        'emergency_fund_exists',
      );
      expect(
        await updateGoal(ctx, fund.id, { kind: 'emergency_fund', name: 'Renamed' }),
      ).toMatchObject({ name: 'Renamed' });
      expect((await updateGoal(ctx, trip.id, { name: 'Trip 2' })).kind).toBe('generic');

      // freeing the slot first makes the change valid
      await archiveGoal(ctx, fund.id);
      expect(await updateGoal(ctx, trip.id, { kind: 'emergency_fund' })).toMatchObject({
        kind: 'emergency_fund',
      });
    });

    it('a concurrent second fund that slips past the check is still emergency_fund_exists', async () => {
      const ctx = await world();
      let inserted!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((r) => (inserted = r));
      const gate = new Promise<void>((r) => (release = r));
      // Another request inserts a fund and has not committed yet: our check cannot see it.
      const holder = withHousehold(t.db, ctx.householdId, async (tx) => {
        await tx.insert(goal).values({
          householdId: ctx.householdId,
          kind: 'emergency_fund',
          name: 'First',
        });
        inserted();
        await gate;
      });
      await ready;
      // codeOf attaches the rejection handler now: on a slow runner the racing request can reach the
      // check only after the holder commits and reject while we still await the holder.
      const racing = codeOf(createGoal(ctx, { kind: 'emergency_fund', name: 'Second' }));
      // let the racing insert reach the unique index and wait on the holder's row
      await new Promise((r) => setTimeout(r, 300));
      release();
      await holder;
      expect(await racing).toBe('emergency_fund_exists');
    });

    it('is also guaranteed by the database, whatever the service does', async () => {
      const ctx = await world();
      await createGoal(ctx, { kind: 'emergency_fund', name: 'Safety net' });
      await expect(
        t.owner.insert(goal).values({
          householdId: ctx.householdId,
          kind: 'emergency_fund',
          name: 'Sneaky',
        }),
      ).rejects.toThrow();
    });
  });
});
