import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { schema } from '@arfolio/db';
import { fetchMerchantLogos, type FetchMerchantLogosDeps, type ServiceCtx } from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const DAY = 86_400_000;

/** A PNG with the given size in its header, padded to `total` bytes. */
function png(width: number, height: number, total = 1_200): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - 24), 7)]);
}
/** An ICO with one entry of the given size (0 means 256), padded to `total` bytes. */
function ico(size: number, total = 1_200): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = size;
  head[7] = size;
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - 22), 3)]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 1)]);
const webp = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(900, 1)]);
const svg = () => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(900)}</svg>`);

type ResponseBody = ConstructorParameters<typeof Response>[0];
type Reply = Response | Error;
const reply = (
  body: Buffer | string | ReadableStream,
  init: ResponseInit = {},
  extra: Partial<Response> = {},
) => {
  const res = new Response(body as ResponseBody, { status: 200, ...init });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(res, k, { value: v });
  return res;
};

describe('fetchMerchantLogos', () => {
  let t: ServicesTestDb;
  let ctx: ServiceCtx;
  let other: ServiceCtx;
  let requests: Array<{ url: string; init: RequestInit | undefined }>;
  const log = { info: () => {}, warn: () => {} };

  const deps = (
    respond: (url: string) => Reply | Promise<Reply>,
    over: Partial<FetchMerchantLogosDeps> = {},
  ): FetchMerchantLogosDeps => ({
    db: ctx.db,
    logger: log,
    enabled: true,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const out = await respond(url);
      if (out instanceof Error) throw out;
      return out;
    },
    ...over,
  });
  const addMerchant = async (key: string, domain: string | null, household = ctx) =>
    (
      await t.owner
        .insert(schema.merchant)
        .values({ householdId: household.householdId, key, displayName: key, domain })
        .returning({ id: schema.merchant.id })
    )[0]!.id;
  const logoOf = async (merchantId: string) =>
    (
      await t.owner
        .select()
        .from(schema.merchantLogo)
        .where(eq(schema.merchantLogo.merchantId, merchantId))
    )[0];
  const run = (d: FetchMerchantLogosDeps) =>
    fetchMerchantLogos(d, { householdId: ctx.householdId });

  beforeAll(async () => {
    t = await startServicesDb();
    ctx = await t.household();
    other = await t.household();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    requests = [];
    const ids = [ctx.householdId, other.householdId];
    await t.owner.delete(schema.merchant).where(inArray(schema.merchant.householdId, ids));
  });

  it('fetches the favicon server-side and stores an image verified by its magic bytes', async () => {
    const id = await addMerchant('A', 'pingodoce.pt');
    const result = await run(
      deps(() => reply(png(128, 128), { headers: { 'content-type': 'image/png' } })),
    );
    expect(result).toMatchObject({ status: 'done', fetched: 1, ok: 1, missing: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://www.google.com/s2/favicons?domain=pingodoce.pt&sz=128');
    expect(requests[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]!.init?.headers).toBeUndefined();
    expect(requests[0]!.init?.credentials).toBe('omit');
    const logo = await logoOf(id);
    expect(logo).toMatchObject({
      status: 'ok',
      contentType: 'image/png',
      householdId: ctx.householdId,
    });
    expect(logo!.bytes).toEqual(png(128, 128));
    expect(logo!.fetchedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['png', () => png(64, 64), 'image/png'],
    ['ico', () => ico(32), 'image/x-icon'],
    ['jpeg', jpeg, 'image/jpeg'],
    ['webp', webp, 'image/webp'],
  ])(
    'accepts %s and stores the type found in the bytes, not the one claimed',
    async (_n, make, type) => {
      const id = await addMerchant('A', 'a.example');
      await run(deps(() => reply(make(), { headers: { 'content-type': 'text/html' } })));
      expect(await logoOf(id)).toMatchObject({ status: 'ok', contentType: type });
    },
  );

  it('never stores an SVG, even when it claims to be a PNG', async () => {
    const id = await addMerchant('A', 'a.example');
    const result = await run(
      deps(() => reply(svg(), { headers: { 'content-type': 'image/png' } })),
    );
    expect(result.missing).toBe(1);
    expect(await logoOf(id)).toMatchObject({ status: 'missing', contentType: null, bytes: null });
  });

  it.each([
    ['the generic globe (a tiny response)', () => reply(png(128, 128, 399))],
    ['a 16x16 PNG', () => reply(png(16, 16))],
    ['a 16x16 ICO', () => reply(ico(16))],
    ['a 404', () => reply('nope', { status: 404 })],
    ['text that is not an image', () => reply(Buffer.alloc(900, 65))],
    ['an empty body', () => reply('')],
  ])('marks %s as missing', async (_name, make) => {
    const id = await addMerchant('A', 'a.example');
    const result = await run(deps(make));
    expect(result).toMatchObject({ fetched: 1, ok: 0, missing: 1 });
    expect(await logoOf(id)).toMatchObject({ status: 'missing', bytes: null });
  });

  it('accepts an image just above 16x16', async () => {
    const a = await addMerchant('A', 'a.example');
    await run(deps(() => reply(png(17, 17))));
    expect((await logoOf(a))!.status).toBe('ok');
  });

  it('marks a body over 100 KB as missing and stops reading it', async () => {
    const id = await addMerchant('A', 'a.example');
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(40_000).fill(1));
      },
    });
    await run(deps(() => reply(body)));
    expect(pulled).toBeLessThan(10);
    expect(await logoOf(id)).toMatchObject({ status: 'missing', bytes: null });
  });

  it('marks a declared length over 100 KB as missing without reading', async () => {
    const id = await addMerchant('A', 'a.example');
    await run(deps(() => reply(png(64, 64), { headers: { 'content-length': '200000' } })));
    expect((await logoOf(id))!.status).toBe('missing');
  });

  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  it('follows redirects itself, one hop at a time, to the favicon CDN', async () => {
    const id = await addMerchant('A', 'a.example');
    const result = await run(
      deps((url) =>
        url.startsWith('https://www.google.com/')
          ? redirect('https://t0.gstatic.com/faviconV2?url=a')
          : url.includes('faviconV2')
            ? redirect('/second', 301)
            : reply(png(64, 64)),
      ),
    );
    expect(result.ok).toBe(1);
    expect(requests.map((r) => r.url)).toEqual([
      'https://www.google.com/s2/favicons?domain=a.example&sz=128',
      'https://t0.gstatic.com/faviconV2?url=a',
      'https://t0.gstatic.com/second',
    ]);
    for (const r of requests) expect(r.init?.redirect).toBe('manual');
    expect((await logoOf(id))!.status).toBe('ok');
  });

  it.each([
    ['plain http', 'http://t0.gstatic.com/x.png'],
    ['a foreign host', 'https://evil.example/x.png'],
    ['a look-alike host', 'https://gstatic.com.evil.example/x.png'],
    ['a suffix look-alike', 'https://evilgstatic.com/x.png'],
    ['a look-alike google host', 'https://notgoogle.com/x.png'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['an address with credentials', 'https://user@evil.example/x.png'],
  ])('marks %s as missing without requesting it', async (_n, location) => {
    const id = await addMerchant('A', 'a.example');
    await run(deps(() => redirect(location)));
    expect(requests).toHaveLength(1);
    expect((await logoOf(id))!.status).toBe('missing');
  });

  it('gives up after three redirects', async () => {
    const id = await addMerchant('A', 'a.example');
    await run(deps(() => redirect('https://t1.gstatic.com/again')));
    expect(requests).toHaveLength(4);
    expect((await logoOf(id))!.status).toBe('missing');
  });

  it('treats a redirect without a location as missing', async () => {
    const id = await addMerchant('A', 'a.example');
    await run(deps(() => new Response(null, { status: 302 })));
    expect((await logoOf(id))!.status).toBe('missing');
  });

  it('leaves no row and stops the run when the provider is unreachable or failing', async () => {
    const a = await addMerchant('A', 'a.example');
    await addMerchant('B', 'b.example');
    const unreachable = await run(deps(() => new Error('connect ECONNREFUSED')));
    expect(unreachable.status).toBe('unavailable');
    expect(requests).toHaveLength(1);
    expect(await logoOf(a)).toBeUndefined();
    requests = [];
    const failing = await run(deps(() => reply('x', { status: 503 })));
    expect(failing.status).toBe('unavailable');
    expect(requests).toHaveLength(1);
    expect(await t.owner.select().from(schema.merchantLogo)).toEqual([]);
  });

  it('does nothing when MERCHANT_LOGOS is off', async () => {
    await addMerchant('A', 'a.example');
    const result = await run(deps(() => reply(png(64, 64)), { enabled: false }));
    expect(result.status).toBe('disabled');
    expect(requests).toHaveLength(0);
  });

  it('picks merchants with a domain and no logo, or a missing one older than 30 days', async () => {
    const none = await addMerchant('NONE', null);
    const fresh = await addMerchant('FRESH', 'fresh.example');
    const okOld = await addMerchant('OKOLD', 'okold.example');
    const missingNew = await addMerchant('MISSNEW', 'missnew.example');
    const missingOld = await addMerchant('MISSOLD', 'missold.example');
    const foreign = await addMerchant('FOREIGN', 'foreign.example', other);
    const now = Date.now();
    const row = (merchantId: string, status: 'ok' | 'missing', age: number) => ({
      merchantId,
      householdId: ctx.householdId,
      status,
      fetchedAt: new Date(now - age),
      ...(status === 'ok' ? { contentType: 'image/png', bytes: png(64, 64) } : {}),
    });
    await t.owner
      .insert(schema.merchantLogo)
      .values([
        row(okOld, 'ok', 90 * DAY),
        row(missingNew, 'missing', 29 * DAY),
        row(missingOld, 'missing', 31 * DAY),
      ]);
    await run(deps(() => reply(png(64, 64))));
    expect(requests.map((r) => new URL(r.url).searchParams.get('domain')).sort()).toEqual([
      'fresh.example',
      'missold.example',
    ]);
    expect((await logoOf(fresh))!.status).toBe('ok');
    expect((await logoOf(missingOld))!.status).toBe('ok');
    expect((await logoOf(missingNew))!.status).toBe('missing');
    expect((await logoOf(okOld))!.fetchedAt.getTime()).toBeLessThan(now - 80 * DAY);
    expect(await logoOf(none)).toBeUndefined();
    expect(await logoOf(foreign)).toBeUndefined();
  });

  it('fetches at most 50 per run by default', async () => {
    await t.owner.insert(schema.merchant).values(
      Array.from({ length: 53 }, (_, i) => ({
        householdId: ctx.householdId,
        key: `M${i}`,
        displayName: `M${i}`,
        domain: `m${i}.example`,
      })),
    );
    await run(deps(() => reply(png(64, 64))));
    expect(requests).toHaveLength(50);
    await run(deps(() => reply(png(64, 64))));
    expect(requests).toHaveLength(53);
  });

  it('never logs domains', async () => {
    await addMerchant('A', 'secretdomain.example');
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    await run(deps(() => reply(png(64, 64)), { logger }));
    await run(deps(() => new Error('boom secretdomain.example'), { logger }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/secretdomain/);
  });
});
