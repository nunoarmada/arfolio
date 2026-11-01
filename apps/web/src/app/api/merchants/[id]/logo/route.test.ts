import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import {
  APP_PASSWORD,
  startTestDb,
  type TestDb,
} from '../../../../../../../../packages/db/test/pg.js';

const state = vi.hoisted(() => ({ db: undefined as unknown, session: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/server/session', () => ({ getSessionContext: async () => state.session }));

import { GET } from './route';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('GET /api/merchants/[id]/logo', () => {
  let testDb: TestDb;
  let db: Db;
  let end: () => Promise<void>;
  let logoId: string;
  let missingId: string;
  let noRowId: string;
  let foreignId: string;

  const call = (id: string) =>
    GET(new Request(`http://localhost/api/merchants/${id}/logo`) as never, {
      params: Promise.resolve({ id }),
    });
  const signIn = (householdId = 'hA') => {
    state.session = { householdId, role: 'viewer', user: { id: 'u1' } };
  };

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    const owner = createDb(testDb.ownerUrl, { max: 2 });
    db = app.db;
    state.db = db;
    end = async () => {
      await app.pool.end();
      await owner.pool.end();
    };
    await owner.db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    const rows = await owner.db
      .insert(schema.merchant)
      .values([
        { householdId: 'hA', key: 'ONE', displayName: 'One' },
        { householdId: 'hA', key: 'TWO', displayName: 'Two' },
        { householdId: 'hA', key: 'THREE', displayName: 'Three' },
        { householdId: 'hB', key: 'FOUR', displayName: 'Four' },
      ])
      .returning({ id: schema.merchant.id });
    [logoId, missingId, noRowId, foreignId] = rows.map((r) => r.id) as [
      string,
      string,
      string,
      string,
    ];
    await owner.db.insert(schema.merchantLogo).values([
      { merchantId: logoId, householdId: 'hA', status: 'ok', contentType: 'image/png', bytes: PNG },
      { merchantId: missingId, householdId: 'hA', status: 'missing' },
      {
        merchantId: foreignId,
        householdId: 'hB',
        status: 'ok',
        contentType: 'image/png',
        bytes: PNG,
      },
    ]);
  });
  afterAll(async () => {
    await end?.();
    await testDb?.drop();
  });
  beforeEach(() => {
    state.session = null;
  });

  it('answers 401 without a signed-in member', async () => {
    const res = await call(logoId);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('returns the bytes with the stored type and the hardening headers', async () => {
    signIn();
    const res = await call(logoId);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it.each([
    ['a missing logo', () => missingId],
    ['a merchant without a logo row', () => noRowId],
    ['another household merchant', () => foreignId],
    ['an unknown id', () => '6f1c2b0e-0000-4000-8000-000000000000'],
    ['an id that is not a uuid', () => 'not-a-uuid'],
  ])('answers 404 for %s', async (_name, id) => {
    signIn();
    const res = await call(id());
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toBe('image/png');
  });
});
