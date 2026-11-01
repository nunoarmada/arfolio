import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeDescription } from '@arfolio/core';
import { schema, withHousehold } from '@arfolio/db';
import {
  confirmRecurring,
  createAccount,
  declareRecurring,
  dismissRecurring,
  findRecurringHouseholds,
  ForbiddenError,
  listRecurring,
  NotFoundError,
  recurringMonthlyCost,
  reopenRecurring,
  runRecurringDetection,
  updateRecurring,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { ensureTransferCategory } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { transaction, recurring, notification } = schema;
const at = (day: string) => new Date(`${day}T12:00:00Z`);

describe('recurring service', () => {
  let t: ServicesTestDb;
  let hashN = 0;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  async function world() {
    const ctx = await t.household({ currency: 'EUR' });
    const account = await createAccount(ctx, { name: 'Hub', type: 'checking' });
    const other = await createAccount(ctx, { name: 'Card', type: 'card' });
    const addTx = async (
      rows: Array<
        Partial<typeof transaction.$inferInsert> & { amount: number; bookingDate: string }
      >,
    ) =>
      withHousehold(ctx.db, ctx.householdId, (tx) =>
        tx.insert(transaction).values(
          rows.map((r) => ({
            householdId: ctx.householdId,
            accountId: account.id,
            dedupeHash: `r${(hashN += 1)}`,
            currency: 'EUR',
            status: 'booked' as const,
            rawDescription: 'DD NETFLIX 123456789',
            counterparty: 'Netflix',
            source: 'manual' as const,
            ...r,
          })),
        ),
      );
    /** Monthly payments on the 5th of the given months of 2026. */
    const monthly = (months: number[], amount: number, extra: Record<string, unknown> = {}) =>
      months.map((m) => ({
        bookingDate: `2026-${String(m).padStart(2, '0')}-05`,
        amount,
        ...extra,
      }));
    const rows = (c: ServiceCtx = ctx) =>
      withHousehold(c.db, c.householdId, (tx) =>
        tx.select().from(recurring).where(eq(recurring.householdId, c.householdId)),
      );
    const notes = (c: ServiceCtx = ctx) =>
      withHousehold(c.db, c.householdId, (tx) =>
        tx.select().from(notification).where(eq(notification.householdId, c.householdId)),
      );
    const run = (day: string, c: ServiceCtx = ctx) =>
      runRecurringDetection({ db: c.db, now: at(day) }, c.householdId);
    return { ctx, account, other, addTx, monthly, rows, notes, run };
  }

  it('detects a subscription from the counterparty and is idempotent across daily reruns', async () => {
    const w = await world();
    await w.addTx(w.monthly([3, 4, 5], -999));
    const first = await w.run('2026-06-01');
    expect(first.created).toBe(1);
    expect(await w.run('2026-06-02')).toEqual({
      created: 0,
      updated: 0,
      missed: 0,
      priceChanges: 0,
    });
    await w.run('2026-06-03');
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantKey: `d:${normalizeDescription('Netflix')}`,
      accountId: w.account.id,
      name: 'Netflix',
      amount: -999,
      currency: 'EUR',
      cadence: 'monthly',
      lastSeenOn: '2026-05-05',
      nextExpectedOn: '2026-06-05',
      status: 'detected',
      source: 'detected',
    });
  });

  it('keys by the text key even when some rows are linked to a merchant, naming it after the merchant', async () => {
    const w = await world();
    const [m] = await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
      tx
        .insert(schema.merchant)
        .values({ householdId: w.ctx.householdId, key: 'NETFLIX', displayName: 'Netflix Inc' })
        .returning(),
    );
    // "Apply to merchant" mid-history: only the latest row got the merchant link.
    await w.addTx(
      w.monthly([3, 4, 5], -999).map((r, i) => ({ ...r, merchantId: i === 2 ? m!.id : null })),
    );
    await w.run('2026-06-01');
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantKey: `d:${normalizeDescription('Netflix')}`,
      name: 'Netflix Inc',
      lastSeenOn: '2026-05-05',
    });
    // Linking the earlier rows later does not split the series or create a second row.
    await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
      tx.update(transaction).set({ merchantId: m!.id }),
    );
    await w.run('2026-06-02');
    expect(await w.rows()).toHaveLength(1);
  });

  it('does not raise a false missed notice when a merchant link appears mid-history', async () => {
    const w = await world();
    const [m] = await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
      tx
        .insert(schema.merchant)
        .values({ householdId: w.ctx.householdId, key: 'NETFLIX', displayName: 'Netflix Inc' })
        .returning(),
    );
    await w.addTx(
      w.monthly([3, 4, 5], -999).map((r, i) => ({ ...r, merchantId: i === 2 ? m!.id : null })),
    );
    await w.run('2026-05-20');
    const [row] = await w.rows();
    await confirmRecurring(w.ctx, row!.id);
    await w.addTx(w.monthly([6], -999, { merchantId: m!.id }));
    await w.run('2026-06-20');
    expect((await w.notes()).filter((n) => n.kind === 'recurring_missed')).toEqual([]);
  });

  it('does not re-suggest an imported subscription that matches by normalised name', async () => {
    const w = await world();
    await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
      tx.insert(recurring).values({
        householdId: w.ctx.householdId,
        merchantKey: `i:${normalizeDescription('Netflix')}`,
        name: 'Netflix',
        amount: -999,
        currency: 'EUR',
        cadence: 'monthly',
        status: 'confirmed',
        source: 'import',
      }),
    );
    await w.addTx(w.monthly([3, 4, 5], -999));
    const result = await w.run('2026-06-01');
    expect(result.created).toBe(0);
    expect(await w.rows()).toHaveLength(1);
  });

  it('ignores transfers, incoming, pending, other currencies and rows older than 400 days', async () => {
    const w = await world();
    const transferCat = await withHousehold(w.ctx.db, w.ctx.householdId, (tx) =>
      ensureTransferCategory(tx, w.ctx.householdId),
    );
    const group = randomUUID();
    await w.addTx([
      ...w.monthly([3, 4, 5], -999, { transferGroupId: group, counterparty: 'Linked' }),
      ...w.monthly([3, 4, 5], -999, { categoryId: transferCat, counterparty: 'Categorised' }),
      ...w.monthly([3, 4, 5], 999, { counterparty: 'Salary' }),
      ...w.monthly([3, 4, 5], -999, { status: 'pending', counterparty: 'Pending' }),
      ...w.monthly([3, 4, 5], -999, { currency: 'USD', counterparty: 'Dollar' }),
      { bookingDate: '2025-03-01', amount: -500, counterparty: 'Old' },
      { bookingDate: '2025-04-01', amount: -500, counterparty: 'Old' },
      { bookingDate: '2025-05-01', amount: -500, counterparty: 'Old' },
    ]);
    const result = await w.run('2026-06-01');
    expect(result.created).toBe(0);
    expect(await w.rows()).toEqual([]);
  });

  it('caps a declared amount at 1e12 minor units', async () => {
    const w = await world();
    await expect(
      declareRecurring(w.ctx, { name: 'Huge', amount: -(1e12 + 1), cadence: 'monthly' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      declareRecurring(w.ctx, { name: 'Huge', amount: 1e12 + 1, cadence: 'monthly' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ok = await declareRecurring(w.ctx, { name: 'Big', amount: -1e12, cadence: 'monthly' });
    await expect(updateRecurring(w.ctx, ok.id, { amount: -(1e12 + 1) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('does not flag one-off purchases at the same merchant', async () => {
    const w = await world();
    await w.addTx([
      { bookingDate: '2026-03-10', amount: -2000, counterparty: 'Shop' },
      { bookingDate: '2026-04-22', amount: -15000, counterparty: 'Shop' },
      { bookingDate: '2026-05-03', amount: -800, counterparty: 'Shop' },
    ]);
    await w.run('2026-06-01');
    expect(await w.rows()).toEqual([]);
  });

  it('detects through a skipped month', async () => {
    const w = await world();
    await w.addTx(w.monthly([1, 2, 4, 5], -999));
    await w.run('2026-06-01');
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cadence: 'monthly', lastSeenOn: '2026-05-05' });
  });

  it('never resurrects a dismissed item and leaves its fields alone', async () => {
    const w = await world();
    await w.addTx(w.monthly([3, 4, 5], -999));
    await w.run('2026-06-01');
    const [row] = await w.rows();
    await dismissRecurring(w.ctx, row!.id);
    await w.addTx([{ bookingDate: '2026-06-05', amount: -999 }]);
    const result = await w.run('2026-06-08');
    expect(result.created).toBe(0);
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'dismissed',
      lastSeenOn: '2026-05-05',
      nextExpectedOn: '2026-06-05',
    });
  });

  it('only advances the dates of a confirmed item', async () => {
    const w = await world();
    await w.addTx(w.monthly([2, 3, 4], -1000));
    await w.run('2026-05-01');
    const [row] = await w.rows();
    await confirmRecurring(w.ctx, row!.id);
    await updateRecurring(w.ctx, row!.id, { name: 'My TV', amount: -1100 });
    await w.addTx(w.monthly([5], -1000));
    await w.run('2026-05-20');
    const [after] = await w.rows();
    expect(after).toMatchObject({
      status: 'confirmed',
      name: 'My TV',
      amount: -1100,
      lastSeenOn: '2026-05-05',
      nextExpectedOn: '2026-06-05',
    });
  });

  it('refreshes the amount of an unconfirmed detection', async () => {
    const w = await world();
    await w.addTx(w.monthly([2, 3, 4], -1000));
    await w.run('2026-05-01');
    await w.addTx(w.monthly([5], -1050));
    await w.run('2026-05-20');
    const [row] = await w.rows();
    expect(row).toMatchObject({ amount: -1000, lastSeenOn: '2026-05-05' });
    await w.addTx(w.monthly([6, 7], -1050));
    await w.run('2026-07-10');
    const [later] = await w.rows();
    expect(later!.amount).toBe(-1025);
  });

  it('attaches detection to a declared item instead of duplicating it', async () => {
    const w = await world();
    const declared = await declareRecurring(w.ctx, {
      name: 'Netflix',
      amount: -999,
      cadence: 'monthly',
      accountId: w.account.id,
    });
    await w.addTx(w.monthly([3, 4, 5], -999));
    await w.run('2026-06-01');
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: declared.id,
      source: 'declared',
      status: 'confirmed',
      lastSeenOn: '2026-05-05',
      nextExpectedOn: '2026-06-05',
    });
  });

  it('does not adopt an old payment for a declared item or notify about it', async () => {
    const w = await world();
    const declared = await declareRecurring(w.ctx, {
      name: 'Netflix',
      amount: -999,
      cadence: 'monthly',
      nextExpectedOn: '2026-07-01',
    });
    await w.addTx([{ bookingDate: '2025-08-24', amount: -999 }]); // 300 days before the run
    await w.run('2026-06-20');
    const [row] = await w.rows();
    expect(row).toMatchObject({
      id: declared.id,
      lastSeenOn: null,
      nextExpectedOn: '2026-07-01',
    });
    expect(await w.notes()).toEqual([]);
  });

  it('adopts a recent matching payment for a declared item but never moves its next date earlier', async () => {
    const w = await world();
    await declareRecurring(w.ctx, {
      name: 'Netflix',
      amount: -999,
      cadence: 'monthly',
      nextExpectedOn: '2026-08-01',
    });
    await w.addTx([{ bookingDate: '2026-06-10', amount: -999 }]);
    await w.run('2026-06-20');
    const [row] = await w.rows();
    expect(row).toMatchObject({ lastSeenOn: '2026-06-10', nextExpectedOn: '2026-08-01' });
  });

  it('ignores a recent payment of a very different amount for a declared item', async () => {
    const w = await world();
    await declareRecurring(w.ctx, { name: 'Netflix', amount: -999, cadence: 'monthly' });
    await w.addTx([{ bookingDate: '2026-06-10', amount: -5000 }]);
    await w.run('2026-06-20');
    expect((await w.rows())[0]!.lastSeenOn).toBeNull();
  });

  it('treats an edit of a detected item as a confirmation that detection no longer overwrites', async () => {
    const w = await world();
    await w.addTx(w.monthly([2, 3, 4], -1000));
    await w.run('2026-05-01');
    const [row] = await w.rows();
    const edited = await updateRecurring(w.ctx, row!.id, { amount: -1100 });
    expect(edited.status).toBe('confirmed');
    await w.run('2026-05-02');
    expect((await w.rows())[0]).toMatchObject({ amount: -1100, status: 'confirmed' });
  });

  it('does not create a detected duplicate beside a declared item of another cadence', async () => {
    const w = await world();
    await declareRecurring(w.ctx, { name: 'Netflix', amount: -999, cadence: 'yearly' });
    await w.addTx(w.monthly([3, 4, 5], -999));
    const result = await w.run('2026-06-01');
    expect(result.created).toBe(0);
    expect(await w.rows()).toHaveLength(1);
  });

  describe('notifications', () => {
    it('notifies once when a confirmed payment is more than 5 days late', async () => {
      const w = await world();
      await w.addTx(w.monthly([3, 4, 5], -999));
      await w.run('2026-06-01');
      const [row] = await w.rows();
      // An unconfirmed guess does not notify.
      await w.run('2026-06-20');
      expect(await w.notes()).toEqual([]);
      await confirmRecurring(w.ctx, row!.id);
      await w.run('2026-06-10'); // 5 days late: not yet
      expect(await w.notes()).toEqual([]);
      await w.run('2026-06-11');
      await w.run('2026-06-12');
      const notes = await w.notes();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        kind: 'recurring_missed',
        userId: null,
        dedupeKey: `recurring-missed:${row!.id}:2026-06-05`,
      });
      expect(notes[0]!.payload).toMatchObject({ recurringId: row!.id, expectedOn: '2026-06-05' });
    });

    it('does not notify when a newer occurrence arrived', async () => {
      const w = await world();
      await w.addTx(w.monthly([3, 4, 5], -999));
      await w.run('2026-06-01');
      const [row] = await w.rows();
      await confirmRecurring(w.ctx, row!.id);
      await w.addTx([{ bookingDate: '2026-06-07', amount: -999 }]);
      await w.run('2026-06-20');
      expect(await w.notes()).toEqual([]);
      const [after] = await w.rows();
      expect(after).toMatchObject({ lastSeenOn: '2026-06-07', nextExpectedOn: '2026-07-07' });
    });

    it('notifies once per month when the latest amount differs by more than 10%', async () => {
      const w = await world();
      await w.addTx(w.monthly([2, 3, 4], -1000));
      await w.run('2026-05-01');
      const [row] = await w.rows();
      await confirmRecurring(w.ctx, row!.id);
      await w.addTx(w.monthly([5], -1200));
      await w.run('2026-05-20');
      await w.run('2026-05-21');
      const notes = await w.notes();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        kind: 'recurring_price_change',
        dedupeKey: `recurring-price:${row!.id}:2026-05:-1200`,
      });
      expect(notes[0]!.payload).toMatchObject({
        recurringId: row!.id,
        previousAmount: -1000,
        amount: -1200,
        currency: 'EUR',
      });
    });

    it('notifies a price change once, then the item carries the new amount (no monthly repeat)', async () => {
      const w = await world();
      await w.addTx(w.monthly([2, 3, 4], -1000));
      await w.run('2026-05-01');
      const [row] = await w.rows();
      await confirmRecurring(w.ctx, row!.id);
      await w.addTx(w.monthly([5], -1200));
      await w.run('2026-05-20');
      expect((await w.rows())[0]!.amount).toBe(-1200);
      // The new price holds the next month: that is not another change.
      await w.addTx(w.monthly([6], -1200));
      await w.run('2026-06-20');
      expect(await w.notes()).toHaveLength(1);
      // A further change is one.
      await w.addTx(w.monthly([7], -1500));
      await w.run('2026-07-20');
      const notes = await w.notes();
      expect(notes).toHaveLength(2);
      expect(notes.map((n) => n.payload)).toContainEqual(
        expect.objectContaining({ previousAmount: -1200, amount: -1500 }),
      );
      expect((await w.rows())[0]!.amount).toBe(-1500);
    });

    it('counts a row once in `updated` when its date and its price both change', async () => {
      const w = await world();
      await w.addTx(w.monthly([2, 3, 4], -1000));
      await w.run('2026-05-01');
      const [row] = await w.rows();
      await confirmRecurring(w.ctx, row!.id);
      await w.addTx(w.monthly([5], -1200));
      const result = await w.run('2026-05-20');
      expect(result).toMatchObject({ priceChanges: 1, updated: 1 });
    });

    it('does not notify for a change of exactly 10% or less', async () => {
      const w = await world();
      await w.addTx(w.monthly([2, 3, 4], -1000));
      await w.run('2026-05-01');
      const [row] = await w.rows();
      await confirmRecurring(w.ctx, row!.id);
      await w.addTx(w.monthly([5], -1100));
      await w.run('2026-05-20');
      expect(await w.notes()).toEqual([]);
    });
  });

  it('computes the monthly cost of confirmed and declared items only', async () => {
    const w = await world();
    await declareRecurring(w.ctx, { name: 'Weekly thing', amount: -1000, cadence: 'weekly' });
    await declareRecurring(w.ctx, { name: 'Quarterly thing', amount: -1001, cadence: 'quarterly' });
    const yearly = await declareRecurring(w.ctx, {
      name: 'Yearly thing',
      amount: -1050,
      cadence: 'yearly',
    });
    await declareRecurring(w.ctx, { name: 'Salary', amount: 200_000, cadence: 'monthly' });
    const gone = await declareRecurring(w.ctx, { name: 'Gone', amount: -5000, cadence: 'monthly' });
    await dismissRecurring(w.ctx, gone.id);
    await w.addTx(w.monthly([3, 4, 5], -999)); // detected, unconfirmed: excluded
    await w.run('2026-06-01');
    expect(await recurringMonthlyCost(w.ctx)).toEqual({ currency: 'EUR', amount: 4333 + 334 + 88 });
    await updateRecurring(w.ctx, yearly.id, { amount: -1200 });
    expect((await recurringMonthlyCost(w.ctx)).amount).toBe(4333 + 334 + 100);
    const detected = (await w.rows()).find((r) => r.source === 'detected')!;
    await confirmRecurring(w.ctx, detected.id);
    expect((await recurringMonthlyCost(w.ctx)).amount).toBe(4333 + 334 + 100 + 999);
  });

  it('lists active items by default, with dismissed ones on request', async () => {
    const w = await world();
    const a = await declareRecurring(w.ctx, { name: 'A', amount: -100, cadence: 'monthly' });
    const b = await declareRecurring(w.ctx, { name: 'B', amount: -200, cadence: 'monthly' });
    await dismissRecurring(w.ctx, b.id);
    expect((await listRecurring(w.ctx)).map((r) => r.id)).toEqual([a.id]);
    expect(
      (await listRecurring(w.ctx, { includeDismissed: true })).map((r) => r.id).sort(),
    ).toEqual([a.id, b.id].sort());
  });

  describe('reopenRecurring', () => {
    it('sends a dismissed or confirmed detected item back to detected', async () => {
      const w = await world();
      await w.addTx(w.monthly([3, 4, 5], -999));
      await w.run('2026-06-01');
      const [row] = await w.rows();
      await dismissRecurring(w.ctx, row!.id);
      await expect(reopenRecurring(w.ctx, row!.id)).resolves.toMatchObject({
        id: row!.id,
        status: 'detected',
      });
      await confirmRecurring(w.ctx, row!.id);
      await expect(reopenRecurring(w.ctx, row!.id)).resolves.toMatchObject({ status: 'detected' });
      // Already detected: nothing to undo, still fine.
      await expect(reopenRecurring(w.ctx, row!.id)).resolves.toMatchObject({ status: 'detected' });
      expect((await w.rows())[0]!.status).toBe('detected');
      expect((await listRecurring(w.ctx)).map((r) => r.id)).toEqual([row!.id]);
    });

    it('refuses declared and imported items with not_reopenable', async () => {
      const w = await world();
      const declared = await declareRecurring(w.ctx, {
        name: 'A',
        amount: -100,
        cadence: 'monthly',
      });
      await expect(reopenRecurring(w.ctx, declared.id)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'not_reopenable',
      });
      await dismissRecurring(w.ctx, declared.id);
      await expect(reopenRecurring(w.ctx, declared.id)).rejects.toMatchObject({
        code: 'not_reopenable',
      });
      await t.owner
        .update(recurring)
        .set({ source: 'import' })
        .where(eq(recurring.id, declared.id));
      await expect(reopenRecurring(w.ctx, declared.id)).rejects.toMatchObject({
        code: 'not_reopenable',
      });
      expect((await w.rows())[0]!.status).toBe('dismissed');
    });

    it('is writer-only, household-scoped and validates the id', async () => {
      const w = await world();
      const w2 = await world();
      await w.addTx(w.monthly([3, 4, 5], -999));
      await w.run('2026-06-01');
      const [row] = await w.rows();
      await dismissRecurring(w.ctx, row!.id);
      await expect(reopenRecurring(withRole(w.ctx, 'viewer'), row!.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(reopenRecurring(w2.ctx, row!.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(reopenRecurring(w.ctx, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
      await expect(reopenRecurring(w.ctx, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      expect((await w.rows())[0]!.status).toBe('dismissed');
    });
  });

  describe('mutations', () => {
    it('are writer-only while viewers can read', async () => {
      const w = await world();
      const row = await declareRecurring(w.ctx, { name: 'A', amount: -100, cadence: 'monthly' });
      const viewer = withRole(w.ctx, 'viewer');
      await expect(
        declareRecurring(viewer, { name: 'B', amount: -1, cadence: 'monthly' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateRecurring(viewer, row.id, { name: 'X' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(confirmRecurring(viewer, row.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(dismissRecurring(viewer, row.id)).rejects.toBeInstanceOf(ForbiddenError);
      expect(await listRecurring(viewer)).toHaveLength(1);
      expect((await recurringMonthlyCost(viewer)).amount).toBe(100);
    });

    it('do not reach another household and validate input', async () => {
      const w = await world();
      const w2 = await world();
      const row = await declareRecurring(w.ctx, { name: 'A', amount: -100, cadence: 'monthly' });
      await expect(confirmRecurring(w2.ctx, row.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(dismissRecurring(w2.ctx, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        declareRecurring(w.ctx, { name: 'Z', amount: 0, cadence: 'monthly' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        declareRecurring(w.ctx, { name: 'Z', amount: -1, cadence: 'daily' as never }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        declareRecurring(w.ctx, {
          name: 'Z',
          amount: -1,
          cadence: 'monthly',
          accountId: w2.account.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('confirm and dismiss are idempotent and update returns the row', async () => {
      const w = await world();
      const row = await declareRecurring(w.ctx, { name: 'A', amount: -100, cadence: 'monthly' });
      expect(row).toMatchObject({ status: 'confirmed', source: 'declared' });
      expect((await dismissRecurring(w.ctx, row.id)).status).toBe('dismissed');
      expect((await dismissRecurring(w.ctx, row.id)).status).toBe('dismissed');
      expect((await confirmRecurring(w.ctx, row.id)).status).toBe('confirmed');
      const updated = await updateRecurring(w.ctx, row.id, {
        nextExpectedOn: '2026-07-01',
        accountId: w.account.id,
      });
      expect(updated).toMatchObject({ nextExpectedOn: '2026-07-01', accountId: w.account.id });
    });
  });

  it('lists every household for the daily job', async () => {
    const w = await world();
    expect(await findRecurringHouseholds(w.ctx.db)).toContain(w.ctx.householdId);
  });

  it('keeps the other household untouched by a run', async () => {
    const w = await world();
    const w2 = await world();
    await w.addTx(w.monthly([3, 4, 5], -999));
    await w.run('2026-06-01');
    expect(await w.rows()).toHaveLength(1);
    expect(await w2.rows(w2.ctx)).toEqual([]);
  });
});
