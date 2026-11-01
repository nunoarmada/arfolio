import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import {
  createAccount,
  getTransaction,
  listReviewInbox,
  listTransactions,
  merchantFieldsFor,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

describe('merchant and location on transaction DTOs', () => {
  let t: ServicesTestDb;
  let ctx: ServiceCtx;
  let accountId: string;
  let seq = 0;
  let withLogo: string;
  let withoutLogo: string;
  let missingLogo: string;

  const insertTx = async (over: Partial<typeof schema.transaction.$inferInsert> = {}) => {
    seq += 1;
    const [row] = await t.owner
      .insert(schema.transaction)
      .values({
        householdId: ctx.householdId,
        accountId,
        dedupeHash: `h${seq}`,
        bookingDate: `2026-10-${String(seq).padStart(2, '0')}`,
        amount: -500,
        currency: 'EUR',
        status: 'booked',
        rawDescription: `SHOP ${seq}`,
        source: 'connector',
        ...over,
      })
      .returning({ id: schema.transaction.id });
    return row!.id;
  };

  beforeAll(async () => {
    t = await startServicesDb();
    ctx = await t.household();
    accountId = (await createAccount(ctx, { name: 'A', type: 'checking' })).id;
    const merchants = await t.owner
      .insert(schema.merchant)
      .values([
        {
          householdId: ctx.householdId,
          key: 'ONE',
          displayName: 'Pingo Doce',
          domain: 'pingodoce.pt',
          nameSource: 'ai',
        },
        {
          householdId: ctx.householdId,
          key: 'TWO',
          displayName: 'No Logo',
          domain: null,
          nameSource: 'ai',
        },
        {
          householdId: ctx.householdId,
          key: 'THREE',
          displayName: 'Gone',
          domain: 'gone.example',
          nameSource: 'user',
        },
      ])
      .returning({ id: schema.merchant.id });
    [withLogo, withoutLogo, missingLogo] = merchants.map((m) => m.id) as [string, string, string];
    await t.owner.insert(schema.merchantLogo).values([
      {
        merchantId: withLogo,
        householdId: ctx.householdId,
        status: 'ok',
        contentType: 'image/png',
        bytes: Buffer.alloc(10),
      },
      { merchantId: missingLogo, householdId: ctx.householdId, status: 'missing' },
    ]);
  });
  afterAll(() => t.close());

  it('lists the merchant with hasLogo and the location from details, null when absent', async () => {
    const a = await insertTx({
      merchantId: withLogo,
      details: { note: 'x', location: { city: 'Lisbon', country: 'PT' } },
    });
    const b = await insertTx({ merchantId: withoutLogo });
    const c = await insertTx({ merchantId: missingLogo, details: { location: { country: 'ES' } } });
    const d = await insertTx({});
    const { items } = await listTransactions(ctx);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId[a]).toMatchObject({
      merchant: { id: withLogo, name: 'Pingo Doce', domain: 'pingodoce.pt', hasLogo: true },
      location: { city: 'Lisbon', country: 'PT' },
    });
    expect(byId[b]).toMatchObject({
      merchant: { id: withoutLogo, name: 'No Logo', domain: null, hasLogo: false },
      location: null,
    });
    expect(byId[c]).toMatchObject({
      merchant: { name: 'Gone', hasLogo: false },
      location: { country: 'ES' },
    });
    expect(byId[d]).toMatchObject({ merchant: null, location: null });
    expect(Object.keys(byId[a]!.merchant!).sort()).toEqual(['domain', 'hasLogo', 'id', 'name']);
    expect(byId[a]).not.toHaveProperty('details');
    expect(JSON.stringify(items)).not.toContain('"bytes"');
  });

  it('reads malformed stored locations as null', async () => {
    const id = await insertTx({ details: { location: { country: 'portugal' } } });
    const { items } = await listTransactions(ctx);
    expect(items.find((i) => i.id === id)!.location).toBeNull();
  });

  it('returns the same fields from the review inbox and the detail', async () => {
    const id = await insertTx({
      merchantId: withLogo,
      needsReview: true,
      details: { location: { city: 'Porto', country: 'PT' } },
    });
    const inbox = await listReviewInbox(ctx);
    expect(inbox.items.find((i) => i.id === id)).toMatchObject({
      merchant: { name: 'Pingo Doce', hasLogo: true },
      location: { city: 'Porto', country: 'PT' },
    });
    expect(await getTransaction(ctx, id)).toMatchObject({
      merchant: { id: withLogo, name: 'Pingo Doce', domain: 'pingodoce.pt', hasLogo: true },
      location: { city: 'Porto', country: 'PT' },
      details: { location: { city: 'Porto', country: 'PT' } },
    });
    const plain = await insertTx({});
    expect(await getTransaction(ctx, plain)).toMatchObject({ merchant: null, location: null });
    const noLogo = await insertTx({ merchantId: missingLogo });
    expect((await getTransaction(ctx, noLogo)).merchant).toMatchObject({ hasLogo: false });
  });

  it('finds a transaction by its friendly merchant name', async () => {
    const id = await insertTx({ merchantId: withLogo, rawDescription: 'COMPRA 9876 XYZ' });
    const found = await listTransactions(ctx, { search: 'pingo doce' });
    expect(found.items.map((r) => r.id)).toContain(id);
    const none = await listTransactions(ctx, { search: 'no such merchant' });
    expect(none.items).toEqual([]);
  });

  it('treats a merchant the memory created from raw text as not named yet', async () => {
    const [remembered] = await t.owner
      .insert(schema.merchant)
      .values({ householdId: ctx.householdId, key: 'RAWTEXT', displayName: 'RAWTEXT 12/06' })
      .returning({ id: schema.merchant.id });
    const id = await insertTx({ merchantId: remembered!.id, rawDescription: 'RAWTEXT 99' });
    const row = (await listTransactions(ctx, { search: 'RAWTEXT 12' })).items.find(
      (r) => r.id === id,
    );
    // Not found by the raw-derived name, and no merchant in the list or the detail.
    expect(row).toBeUndefined();
    expect((await listTransactions(ctx, { search: 'RAWTEXT 99' })).items[0]!.merchant).toBeNull();
    expect((await getTransaction(ctx, id)).merchant).toBeNull();
  });

  it('looks up the merchant and location of given rows in one call, for write results', async () => {
    const a = await insertTx({
      merchantId: withLogo,
      details: { location: { city: 'Lisbon', country: 'PT' } },
    });
    const b = await insertTx({});
    const fields = await merchantFieldsFor(ctx, [
      a,
      b,
      'not-a-uuid',
      '6f1c2b0e-0000-4000-8000-000000000000',
    ]);
    expect(fields.get(a)).toEqual({
      merchant: { id: withLogo, name: 'Pingo Doce', domain: 'pingodoce.pt', hasLogo: true },
      location: { city: 'Lisbon', country: 'PT' },
    });
    expect(fields.get(b)).toEqual({ merchant: null, location: null });
    expect(fields.size).toBe(2);
    expect((await merchantFieldsFor(ctx, [])).size).toBe(0);
  });
});
