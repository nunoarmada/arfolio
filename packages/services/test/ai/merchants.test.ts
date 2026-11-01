import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import {
  createAccount,
  enrichMerchants,
  type AiCategoriseDeps,
  type AnthropicLike,
  type ServiceCtx,
} from '../../src/index.js';
import { startServicesDb, type ServicesTestDb } from '../helpers.js';

type Call = Parameters<AnthropicLike['messages']['parse']>[0];
type Item = {
  id: string;
  merchant: string | null;
  domain: string | null;
  city: string | null;
  country: string | null;
  isPerson: boolean;
};
type PromptRow = {
  id: string;
  description: string;
  counterparty: string | null;
  mcc: string | null;
  mccLabel: string | null;
  direction: 'in' | 'out';
  currency: string;
  countryHint: string | null;
};

const rowsOf = (call: Call): PromptRow[] =>
  (JSON.parse(call.messages[0]!.content) as { transactions: PromptRow[] }).transactions;
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  merchant: null,
  domain: null,
  city: null,
  country: null,
  isPerson: false,
  ...over,
});

describe('enrichMerchants', () => {
  let t: ServicesTestDb;
  let ctx: ServiceCtx;
  let off: ServiceCtx;
  let accountId: string;
  let offAccountId: string;
  let calls: Call[];
  let seq = 0;

  const log = { info: () => {}, warn: () => {} };
  const deps = (
    respond: (call: Call, n: number) => Promise<unknown> | unknown,
    over: Partial<AiCategoriseDeps> = {},
  ): AiCategoriseDeps => ({
    db: ctx.db,
    anthropic: {
      messages: {
        async parse(params: Call) {
          calls.push(params);
          const out = await respond(params, calls.length - 1);
          return {
            parsed_output: out,
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      },
    },
    model: 'test-model',
    logger: log,
    ...over,
  });
  /** Answers each prompt row with `pick(row)` (null leaves the row unanswered). */
  const answer =
    (pick: (row: PromptRow) => Partial<Item> | null) =>
    (call: Call): { items: Item[] } => ({
      items: rowsOf(call).flatMap((r) => {
        const over = pick(r);
        return over ? [item(r.id, over)] : [];
      }),
    });

  /** An account linked to an active Trading 212 connection. */
  async function t212Account(household = ctx): Promise<string> {
    const id = (await createAccount(household, { name: 'T212', type: 'investment' })).id;
    const [conn] = await t.owner
      .insert(schema.connection)
      .values({
        householdId: household.householdId,
        provider: 'trading212',
        displayName: 'T212',
        status: 'active',
        createdBy: 'user-1',
      })
      .returning({ id: schema.connection.id });
    await t.owner.insert(schema.connectionAccount).values({
      householdId: household.householdId,
      connectionId: conn!.id,
      accountId: id,
      externalUid: '1',
      externalKey: `k${id}`,
      currency: 'EUR',
      name: 'T212',
    });
    return id;
  }
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  async function insertTx(
    over: Partial<typeof schema.transaction.$inferInsert> = {},
    household = ctx,
  ): Promise<string> {
    seq += 1;
    const [row] = await t.owner
      .insert(schema.transaction)
      .values({
        householdId: household.householdId,
        accountId: household === ctx ? accountId : offAccountId,
        dedupeHash: `h${seq}`,
        bookingDate: '2026-10-05',
        amount: -1_250,
        currency: 'EUR',
        status: 'booked',
        rawDescription: `COMPRA 1234 SHOP ${seq}`,
        source: 'connector',
        ...over,
      })
      .returning({ id: schema.transaction.id });
    return row!.id;
  }
  const stored = async (id: string) =>
    (await t.owner.select().from(schema.transaction).where(eq(schema.transaction.id, id)))[0]!;
  const merchants = (household = ctx) =>
    t.owner
      .select()
      .from(schema.merchant)
      .where(eq(schema.merchant.householdId, household.householdId));

  beforeAll(async () => {
    t = await startServicesDb();
    ctx = await t.household({ locale: 'en' });
    off = await t.household();
    await withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx
        .update(schema.householdSettings)
        .set({ aiEnabled: true })
        .where(eq(schema.householdSettings.householdId, ctx.householdId)),
    );
    accountId = (await createAccount(ctx, { name: 'Secret Account Name', type: 'checking' })).id;
    offAccountId = (await createAccount(off, { name: 'Other', type: 'checking' })).id;
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    calls = [];
    const ids = [ctx.householdId, off.householdId];
    await t.owner.delete(schema.transaction).where(inArray(schema.transaction.householdId, ids));
    await t.owner.delete(schema.merchant).where(inArray(schema.merchant.householdId, ids));
  });

  it('leaves recent Trading 212 card rows without a merchant for the export, and names them once old', async () => {
    await t.owner
      .insert(schema.user)
      .values({ id: 'user-1', name: 'u', email: 'u@example.test' })
      .onConflictDoNothing();
    const t212 = await t212Account();
    const fresh = await insertTx({
      accountId: t212,
      rawDescription: 'WITHDRAW abc123',
      bookingDate: daysAgo(2),
    });
    await insertTx({
      accountId: t212,
      rawDescription: 'WITHDRAW old999',
      bookingDate: daysAgo(45),
    });
    await insertTx({ rawDescription: 'WITHDRAW bank1', bookingDate: daysAgo(2) });
    await enrichMerchants(deps(answer(() => null)), { householdId: ctx.householdId });
    expect(
      rowsOf(calls[0]!)
        .map((r) => r.description)
        .sort(),
    ).toEqual(['WITHDRAW bank1', 'WITHDRAW old999']);
    const row = await stored(fresh);
    expect(row.merchantEnrichAttempts).toBe(0);
    expect(row.merchantEnrichedAt).toBeNull();
  });

  it('asks once per merchant key and links every row of the group', async () => {
    const a = await insertTx({ rawDescription: 'COMPRA PINGO DOCE LISBOA PT' });
    const b = await insertTx({ rawDescription: 'PAGAMENTO PINGO DOCE LISBOA PT' });
    const c = await insertTx({ rawDescription: 'COMPRA CAFE CENTRAL' });
    const result = await enrichMerchants(
      deps(
        answer((r) =>
          r.description.includes('PINGO')
            ? { merchant: 'Pingo Doce', domain: 'pingodoce.pt', city: 'Lisbon', country: 'PT' }
            : { merchant: 'Cafe Central' },
        ),
      ),
      { householdId: ctx.householdId },
    );
    expect(calls).toHaveLength(1);
    expect(rowsOf(calls[0]!)).toHaveLength(2);
    expect(result).toMatchObject({ status: 'done', merchants: 2, rows: 3 });
    const all = await merchants();
    expect(all.map((m) => m.displayName).sort()).toEqual(['Cafe Central', 'Pingo Doce']);
    const pingo = all.find((m) => m.displayName === 'Pingo Doce')!;
    expect(pingo).toMatchObject({ domain: 'pingodoce.pt', nameSource: 'ai' });
    expect(pingo.enrichedAt).toBeInstanceOf(Date);
    for (const id of [a, b]) {
      const row = await stored(id);
      expect(row.merchantId).toBe(pingo.id);
      expect(row.merchantEnrichedAt).toBeInstanceOf(Date);
      expect(row.details).toEqual({ location: { city: 'Lisbon', country: 'PT' } });
    }
    expect((await stored(c)).merchantId).toBe(
      all.find((m) => m.displayName === 'Cafe Central')!.id,
    );
  });

  it('sends redacted text, mcc with its label, direction and a country hint, never the amount', async () => {
    await insertTx({
      rawDescription: 'COMPRA 1234 SHOP jane@example.com 912 345 678',
      counterparty: 'ACME 12345678',
      mcc: '5411',
      amount: -4_321,
      details: { counterpartyAccount: { iban: 'DE89370400440532013000' } },
    });
    await enrichMerchants(deps(answer(() => ({}))), { householdId: ctx.householdId });
    const [row] = rowsOf(calls[0]!);
    expect(row).toMatchObject({
      description: 'COMPRA 1234 SHOP # #',
      counterparty: 'ACME #',
      mcc: '5411',
      direction: 'out',
      currency: 'EUR',
      countryHint: 'DE',
    });
    expect(row!.mccLabel).toEqual(expect.any(String));
    const sent = JSON.stringify(calls[0]);
    expect(sent).not.toContain('jane@example.com');
    expect(sent).not.toContain('43.21');
    expect(sent).not.toContain('Secret Account Name');
  });

  it('only looks at booked rows that were not looked at before', async () => {
    await insertTx({ rawDescription: 'PENDING SHOP', status: 'pending' });
    await insertTx({ rawDescription: 'DONE SHOP', merchantEnrichedAt: new Date() });
    await insertTx({ rawDescription: 'FOREIGN SHOP' }, off);
    const fresh = await insertTx({ rawDescription: 'FRESH SHOP' });
    await enrichMerchants(deps(answer(() => ({ merchant: 'Fresh' }))), {
      householdId: ctx.householdId,
    });
    expect(rowsOf(calls[0]!).map((r) => r.description)).toEqual(['FRESH SHOP']);
    await enrichMerchants(deps(answer(() => ({}))), { householdId: ctx.householdId });
    expect(calls).toHaveLength(1);
    expect((await stored(fresh)).merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('renames a memory merchant but never a name the user set, and only fills a missing domain', async () => {
    await t.owner.insert(schema.merchant).values([
      { householdId: ctx.householdId, key: 'SHOP ONE', displayName: 'shop one raw' },
      {
        householdId: ctx.householdId,
        key: 'SHOP TWO',
        displayName: 'My Shop',
        nameSource: 'user',
        domain: 'mine.example',
      },
      {
        householdId: ctx.householdId,
        key: 'SHOP THREE',
        displayName: 'Old ai',
        nameSource: 'ai',
        domain: 'old.example',
      },
    ]);
    const one = await insertTx({ rawDescription: 'COMPRA SHOP ONE' });
    const two = await insertTx({ rawDescription: 'COMPRA SHOP TWO' });
    const three = await insertTx({ rawDescription: 'COMPRA SHOP THREE' });
    await enrichMerchants(
      deps(
        answer((r) => ({
          merchant: r.description.includes('ONE') ? 'Shop One' : 'Shop Brand',
          domain: 'shop-brand.example',
        })),
      ),
      { householdId: ctx.householdId },
    );
    const byKey = Object.fromEntries((await merchants()).map((m) => [m.key, m]));
    expect(byKey['SHOP ONE']).toMatchObject({
      displayName: 'Shop One',
      nameSource: 'ai',
      domain: 'shop-brand.example',
    });
    expect(byKey['SHOP TWO']).toMatchObject({
      displayName: 'My Shop',
      nameSource: 'user',
      domain: 'mine.example',
    });
    expect(byKey['SHOP THREE']).toMatchObject({
      displayName: 'Shop Brand',
      nameSource: 'ai',
      domain: 'old.example',
    });
    expect((await stored(one)).merchantId).toBe(byKey['SHOP ONE']!.id);
    expect((await stored(two)).merchantId).toBe(byKey['SHOP TWO']!.id);
    expect((await stored(three)).merchantId).toBe(byKey['SHOP THREE']!.id);
  });

  it('keeps an existing merchant link and merges the location without dropping other keys', async () => {
    const [m] = await t.owner
      .insert(schema.merchant)
      .values({ householdId: ctx.householdId, key: 'LINKED', displayName: 'Linked' })
      .returning();
    const [other] = await t.owner
      .insert(schema.merchant)
      .values({ householdId: ctx.householdId, key: 'OTHER', displayName: 'Other' })
      .returning();
    const id = await insertTx({
      rawDescription: 'COMPRA LINKED',
      merchantId: other!.id,
      details: { note: 'keep me', location: { country: 'ES' } },
    });
    await enrichMerchants(
      deps(answer(() => ({ merchant: 'Linked', city: 'Madrid', country: 'PT' }))),
      { householdId: ctx.householdId },
    );
    const row = await stored(id);
    expect(row.merchantId).toBe(other!.id);
    expect(row.details).toEqual({ note: 'keep me', location: { city: 'Madrid', country: 'ES' } });
    expect(m).toBeDefined();
  });

  it('skips the location merge when details would pass the size cap', async () => {
    const big = {
      note: 'y'.repeat(1_000),
      remittance: Array.from({ length: 10 }, () => 'r'.repeat(500)),
    };
    const id = await insertTx({ details: big });
    await enrichMerchants(deps(answer(() => ({ merchant: 'Shop', city: 'Porto' }))), {
      householdId: ctx.householdId,
    });
    const row = await stored(id);
    expect(row.details).toEqual(big);
    expect(row.merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('creates no merchant for a person or an unknown, but marks the rows as looked at', async () => {
    const person = await insertTx({ rawDescription: 'TRF PARA JOAO SILVA' });
    const unknown = await insertTx({ rawDescription: 'XPTO 77' });
    const result = await enrichMerchants(
      deps(
        answer((r) =>
          r.description.includes('JOAO')
            ? { merchant: 'Joao Silva', isPerson: true, city: 'Porto', country: 'PT' }
            : { merchant: null },
        ),
      ),
      { householdId: ctx.householdId },
    );
    expect(await merchants()).toEqual([]);
    expect(result).toMatchObject({ merchants: 0, rows: 2 });
    for (const id of [person, unknown]) {
      const row = await stored(id);
      expect(row.merchantId).toBeNull();
      expect(row.merchantEnrichedAt).toBeInstanceOf(Date);
      expect(row.details).toBeNull();
    }
  });

  it('leaves rows the model skipped or garbled unmarked and counts the attempt, up to three', async () => {
    const skipped = await insertTx({ rawDescription: 'SKIPPED SHOP' });
    const garbled = await insertTx({ rawDescription: 'GARBLED SHOP' });
    const answered = await insertTx({ rawDescription: 'ANSWERED SHOP' });
    const respond = (call: Call) => ({
      items: [
        ...rowsOf(call)
          .filter((r) => r.description === 'ANSWERED SHOP')
          .map((r) => item(r.id, { merchant: 'Answered' })),
        { id: rowsOf(call).find((r) => r.description === 'GARBLED SHOP')!.id, merchant: 42 },
      ],
    });
    await enrichMerchants(deps(respond), { householdId: ctx.householdId });
    expect(await stored(skipped)).toMatchObject({
      merchantEnrichedAt: null,
      merchantEnrichAttempts: 1,
    });
    expect(await stored(garbled)).toMatchObject({
      merchantEnrichedAt: null,
      merchantEnrichAttempts: 1,
    });
    expect(await stored(answered)).toMatchObject({ merchantEnrichAttempts: 1 });
    expect((await stored(answered)).merchantEnrichedAt).toBeInstanceOf(Date);
    await enrichMerchants(deps(respond), { householdId: ctx.householdId });
    await enrichMerchants(deps(respond), { householdId: ctx.householdId });
    expect(calls.map((c) => rowsOf(c).length)).toEqual([3, 2, 2]);
    expect(await stored(skipped)).toMatchObject({
      merchantEnrichedAt: null,
      merchantEnrichAttempts: 3,
    });
    await enrichMerchants(deps(respond), { householdId: ctx.householdId });
    expect(calls).toHaveLength(3);
  });

  it.each([
    'https://example.com',
    'example.com/path',
    '10.0.0.1',
    'localhost',
    'Exa mple.com',
    `${'a'.repeat(250)}.com`,
    'exa_mple.com',
  ])('rejects the domain %s but keeps the merchant', async (domain) => {
    await insertTx({ rawDescription: 'COMPRA SHOP X' });
    await enrichMerchants(deps(answer(() => ({ merchant: 'Shop X', domain }))), {
      householdId: ctx.householdId,
    });
    expect(await merchants()).toMatchObject([{ displayName: 'Shop X', domain: null }]);
  });

  it('lower-cases a valid domain', async () => {
    await insertTx({ rawDescription: 'COMPRA SHOP X' });
    await enrichMerchants(deps(answer(() => ({ merchant: 'Shop X', domain: 'WWW.Shop-X.com' }))), {
      householdId: ctx.householdId,
    });
    expect(await merchants()).toMatchObject([{ domain: 'www.shop-x.com' }]);
  });

  it('drops a malformed location but keeps a valid country', async () => {
    const id = await insertTx();
    await enrichMerchants(
      deps(answer(() => ({ merchant: 'Shop', city: '   ', country: 'Portugal' }))),
      { householdId: ctx.householdId },
    );
    expect((await stored(id)).details).toBeNull();
    const id2 = await insertTx();
    await enrichMerchants(deps(answer(() => ({ merchant: 'Shop', country: 'pt' }))), {
      householdId: ctx.householdId,
    });
    expect((await stored(id2)).details).toEqual({ location: { country: 'PT' } });
  });

  it('does nothing when AI is off for the household or the installation has no key', async () => {
    await insertTx({}, off);
    const id = await insertTx();
    const disabled = await enrichMerchants(deps(answer(() => ({ merchant: 'X' }))), {
      householdId: off.householdId,
    });
    expect(disabled.status).toBe('disabled');
    const noKey = await enrichMerchants(
      deps(() => ({}), { anthropic: null }),
      {
        householdId: ctx.householdId,
      },
    );
    expect(noKey.status).toBe('no_api_key');
    expect(calls).toHaveLength(0);
    expect((await stored(id)).merchantEnrichedAt).toBeNull();
    expect(await merchants(off)).toEqual([]);
  });

  it('caps a run, sends batches of at most 50 merchants, newest rows first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        await insertTx({
          rawDescription: `SHOP ${String.fromCharCode(65 + i)}`,
          bookingDate: `2026-10-0${i + 1}`,
        }),
      );
    }
    await enrichMerchants(
      deps(
        answer(() => ({ merchant: 'M' })),
        { maxRowsPerRun: 5, batchSize: 2 },
      ),
      { householdId: ctx.householdId },
    );
    expect(calls.map((c) => rowsOf(c).length)).toEqual([2, 2, 1]);
    expect(rowsOf(calls[0]!)[0]!.description).toBe('SHOP G');
    expect((await stored(ids[0]!)).merchantEnrichedAt).toBeNull();
    expect((await stored(ids[6]!)).merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('uses the documented defaults of 300 rows per run and 50 per batch', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      householdId: ctx.householdId,
      accountId,
      dedupeHash: `bulk${i}-${seq}`,
      bookingDate: '2026-10-05',
      amount: -100,
      currency: 'EUR',
      status: 'booked' as const,
      rawDescription: `BULK SHOP ${i}`,
      source: 'connector' as const,
    }));
    await t.owner.insert(schema.transaction).values(rows);
    await enrichMerchants(deps(answer(() => ({}))), { householdId: ctx.householdId });
    expect(calls.map((c) => rowsOf(c).length)).toEqual([50, 50, 20]);
  });

  it('leaves rows unmarked when a batch fails and stops the run on a rate limit', async () => {
    const a = await insertTx({ rawDescription: 'SHOP A' });
    const b = await insertTx({ rawDescription: 'SHOP B' });
    const failing = await enrichMerchants(
      deps(
        () => {
          throw Object.assign(new Error('rate'), { status: 429 });
        },
        { batchSize: 1 },
      ),
      { householdId: ctx.householdId },
    );
    expect(failing.status).toBe('rate_limited');
    expect(calls).toHaveLength(1);
    for (const id of [a, b]) expect((await stored(id)).merchantEnrichedAt).toBeNull();
    // Only the batch that was sent counts as an attempt.
    expect(
      (await stored(a)).merchantEnrichAttempts + (await stored(b)).merchantEnrichAttempts,
    ).toBe(1);
    const broken = await enrichMerchants(
      deps(() => {
        throw new Error('boom');
      }),
      { householdId: ctx.householdId },
    );
    expect(broken.status).toBe('done');
    for (const id of [a, b]) expect((await stored(id)).merchantEnrichedAt).toBeNull();
    expect((await stored(a)).merchantEnrichAttempts).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['Shop www.shop.com', 'Shop'],
    ['Visit https://x.example/a now', 'Visit now'],
    ['Pingo Doce 351912345678', 'Pingo Doce'],
    ['Pingo Doce +351 912 345 678', 'Pingo Doce'],
    ['  Pingo \n  Doce  ', 'Pingo Doce'],
    ['Amazon.com', null],
    ['https://evil.example', null],
    ['1234567', null],
    ['A'.repeat(80), 'A'.repeat(60)],
  ])('cleans the model name %j into %j', async (name, expected) => {
    const id = await insertTx();
    await enrichMerchants(deps(answer(() => ({ merchant: name }))), {
      householdId: ctx.householdId,
    });
    const all = await merchants();
    if (expected === null) {
      expect(all).toEqual([]);
      expect((await stored(id)).merchantId).toBeNull();
    } else {
      expect(all.map((m) => m.displayName)).toEqual([expected]);
    }
    expect((await stored(id)).merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('treats money received without an mcc as a person: no merchant, no domain, location kept', async () => {
    const id = await insertTx({ amount: 5_000, rawDescription: 'TRF DE MARIA' });
    await enrichMerchants(
      deps(
        answer(() => ({
          merchant: 'Maria',
          domain: 'maria.example',
          city: 'Porto',
          country: 'PT',
        })),
      ),
      { householdId: ctx.householdId },
    );
    expect(await merchants()).toEqual([]);
    const row = await stored(id);
    expect(row.merchantId).toBeNull();
    expect(row.details).toEqual({ location: { city: 'Porto', country: 'PT' } });
    expect(row.merchantEnrichedAt).toBeInstanceOf(Date);
  });

  it('accepts a merchant for money received when the row has an mcc (a refund)', async () => {
    await insertTx({ amount: 900, mcc: '5411', rawDescription: 'REFUND PINGO DOCE' });
    await enrichMerchants(
      deps(answer(() => ({ merchant: 'Pingo Doce', domain: 'pingodoce.pt' }))),
      { householdId: ctx.householdId },
    );
    expect(await merchants()).toMatchObject([
      { displayName: 'Pingo Doce', domain: 'pingodoce.pt' },
    ]);
  });

  it.each([
    ['Pingo Doce', 'amazon.com', null],
    ['Pingo Doce', 'pingodoce.pt', 'pingodoce.pt'],
    ['Pingo Doce', 'www.pingodoce.pt', 'www.pingodoce.pt'],
    ['Café Pastéis de Belém', 'pasteisdebelem.pt', 'pasteisdebelem.pt'],
    ['Tesco', 'tesco.co.uk', 'tesco.co.uk'],
    ['Tesco', 'shop.example.co.uk', null],
    ['Amazon', 'amzn.com', null],
    ['CTT', 'ctt.pt', 'ctt.pt'],
    ['CTT Correios', 'ctt.pt', 'ctt.pt'],
    ['Correios CTT Lisboa', 'www.ctt.pt', 'www.ctt.pt'],
    ['ÉDP', 'edp.pt', 'edp.pt'],
    ['Pingo Doce', 'pin.pt', null],
    ['Cattle Shop', 'ctt.pt', null],
    ['Worten', 'wor-ten.pt', null],
  ])('keeps the name %s but only a matching domain (%s -> %s)', async (name, domain, expected) => {
    await insertTx();
    await enrichMerchants(deps(answer(() => ({ merchant: name, domain }))), {
      householdId: ctx.householdId,
    });
    expect(await merchants()).toMatchObject([{ displayName: name, domain: expected }]);
  });

  it('never logs descriptions or names', async () => {
    await insertTx({ rawDescription: 'COMPRA SECRETSHOP' });
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    await enrichMerchants(
      deps(
        answer(() => ({ merchant: 'SecretBrand', domain: 'secretbrand.example' })),
        { logger },
      ),
      { householdId: ctx.householdId },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/secret/i);
  });
});
