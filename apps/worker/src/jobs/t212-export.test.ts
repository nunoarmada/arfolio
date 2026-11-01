import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderRateLimitError, type HistoryExport } from '@arfolio/connectors';
import { encryptSecret } from '@arfolio/core/server';
import { createDb, schema, type Db } from '@arfolio/db';
import type { ConnectorDeps } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { runT212ExportJob, T212_MAX_ATTEMPTS, type T212ExportJobDeps } from './t212-export.js';

const warnings = vi.hoisted(() => [] as string[]);
vi.mock('../log.js', () => ({
  log: {
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => {},
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'unknown error'),
}));

const KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-29T12:00:00.000Z');
const CSV = 'Action,ID,Notes,Merchant name\nCard debit,ref-1,,Cafe Lisboa\n';

type Fake = {
  requests: Array<{ timeFrom: string; timeTo: string }>;
  downloads: string[];
  exports: HistoryExport[];
  requestError?: Error;
  csv?: string;
};

describe('t212-export job', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  const ends: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    const own = createDb(testDb.ownerUrl, { max: 2 });
    db = app.db;
    owner = own.db;
    ends.push(
      () => app.pool.end(),
      () => own.pool.end(),
    );
  });
  afterAll(async () => {
    for (const end of ends) await end();
    await testDb?.drop();
  });

  /** A Trading 212 connection with one unenriched card payment booked on `date`. */
  async function broker(opts: { rows?: boolean; provider?: 'trading212' | 'enablebanking' } = {}) {
    const householdId = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id: householdId, name: 'T', slug: householdId, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId });
    const id = randomUUID();
    const accountId = randomUUID();
    await owner.insert(schema.financialAccount).values({
      id: accountId,
      householdId,
      name: 'T212',
      type: 'investment',
      currency: 'EUR',
    });
    await owner.insert(schema.connection).values({
      id,
      householdId,
      provider: opts.provider ?? 'trading212',
      displayName: 'Broker',
      status: 'active',
      credentialsEnc: encryptSecret(
        JSON.stringify({ apiKey: 'k', apiSecret: 's' }),
        KEY,
        `connection:${id}:credentials`,
      ),
      createdBy: 'u',
    });
    await owner.insert(schema.connectionAccount).values({
      householdId,
      connectionId: id,
      accountId,
      externalUid: '1',
      externalKey: '1',
      currency: 'EUR',
      name: 'T212',
    });
    if (opts.rows !== false) {
      await owner.insert(schema.transaction).values({
        householdId,
        accountId,
        externalId: 'tx:ref-1',
        dedupeHash: randomUUID(),
        bookingDate: '2026-10-20',
        amount: -450,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'WITHDRAW ref-1',
        source: 'connector',
      });
    }
    return { householdId, id };
  }

  function setup(fake: Fake) {
    const enqueued: Array<{ data: Record<string, unknown>; startAfter: number }> = [];
    const applied: string[] = [];
    const connectors: ConnectorDeps = {
      encryptionKey: KEY,
      trading212: () => ({
        getAccountSummary: async () => {
          throw new Error('unused');
        },
        getPositions: async () => [],
        listPies: async () => [],
        getPieName: async () => 'Pie',
        listTransactions: async () => ({ items: [], incomplete: false }),
        listDividends: async () => ({ items: [], incomplete: false }),
        requestHistoryExport: async (range) => {
          if (fake.requestError) throw fake.requestError;
          fake.requests.push(range);
          return 7;
        },
        listHistoryExports: async () => fake.exports,
        downloadHistoryExport: async (url) => {
          fake.downloads.push(url);
          return fake.csv ?? CSV;
        },
      }),
    };
    const deps: T212ExportJobDeps = {
      db,
      connectors,
      now: () => NOW,
      enqueue: async (data, startAfter) => {
        enqueued.push({ data: { ...data }, startAfter });
      },
      afterApply: async (householdId) => {
        applied.push(householdId);
      },
    };
    return { deps, enqueued, applied };
  }

  const fresh = (): Fake => ({ requests: [], downloads: [], exports: [] });
  const description = async (householdId: string) =>
    (
      await owner
        .select({ d: schema.transaction.rawDescription })
        .from(schema.transaction)
        .where(eq(schema.transaction.householdId, householdId))
    )[0]?.d;

  it('requests an export from the oldest unenriched row and polls in 60 s', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    const { deps, enqueued } = setup(fake);
    await runT212ExportJob(deps, { householdId, connectionId: id, attempt: 0 });
    expect(fake.requests).toEqual([
      { timeFrom: '2026-10-20T00:00:00.000Z', timeTo: '2026-10-29T12:00:00.000Z' },
    ]);
    expect(enqueued).toEqual([
      {
        data: { householdId, connectionId: id, reportId: 7, through: '2026-10-26', attempt: 0 },
        startAfter: 60,
      },
    ]);
  });

  it('caps the export range to 365 days', async () => {
    const { householdId, id } = await broker();
    await owner
      .update(schema.transaction)
      .set({ bookingDate: '2024-01-01' })
      .where(eq(schema.transaction.householdId, householdId));
    const fake = fresh();
    await runT212ExportJob(setup(fake).deps, { householdId, connectionId: id, attempt: 0 });
    expect(fake.requests[0]?.timeFrom).toBe('2025-10-29T12:00:00.000Z');
  });

  it('requests nothing when no row needs enriching or the provider is not Trading 212', async () => {
    const none = await broker({ rows: false });
    const bank = await broker({ provider: 'enablebanking' });
    for (const c of [none, bank]) {
      const fake = fresh();
      const { deps, enqueued } = setup(fake);
      await runT212ExportJob(deps, { householdId: c.householdId, connectionId: c.id, attempt: 0 });
      expect(fake.requests).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    }
  });

  it('downloads and applies a finished export, then queues AI categorisation', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.exports = [
      { reportId: 3, status: 'Finished', downloadLink: 'https://other.test/old' },
      { reportId: 7, status: 'Finished', downloadLink: 'https://s3.test/x.csv' },
    ];
    const { deps, enqueued, applied } = setup(fake);
    await runT212ExportJob(deps, {
      householdId,
      connectionId: id,
      reportId: 7,
      through: '2026-10-28',
      attempt: 2,
    });
    expect(fake.downloads).toEqual(['https://s3.test/x.csv']);
    expect(await description(householdId)).toBe('Cafe Lisboa');
    expect(applied).toEqual([householdId]);
    expect(enqueued).toHaveLength(0);
  });

  it('does not apply or advance when the CSV header is not recognised, and warns with known column names only', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.exports = [{ reportId: 7, status: 'Finished', downloadLink: 'https://s3.test/x.csv' }];
    fake.csv = 'Action,Reference,Secret Shop\nCard debit,ref-1,Secret Shop\n';
    warnings.length = 0;
    const { deps, enqueued, applied } = setup(fake);
    await runT212ExportJob(deps, {
      householdId,
      connectionId: id,
      reportId: 7,
      through: '2026-10-28',
      attempt: 0,
    });
    expect(await description(householdId)).toBe('WITHDRAW ref-1');
    const [conn] = await owner
      .select({ through: schema.connection.t212EnrichedThrough })
      .from(schema.connection)
      .where(eq(schema.connection.id, id));
    expect(conn?.through).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(applied).toHaveLength(0);
    const warning = warnings.find((w) => w.includes('not recognised'));
    expect(warning).toContain('Action (+2 unknown)');
    expect(warnings.join('\n')).not.toContain('Secret Shop');
  });

  it('re-enqueues a running export in 60 s with the next attempt', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.exports = [{ reportId: 7, status: 'Running' }];
    const { deps, enqueued } = setup(fake);
    const data = { householdId, connectionId: id, reportId: 7, through: '2026-10-28' };
    await runT212ExportJob(deps, { ...data, attempt: 4 });
    expect(enqueued).toEqual([{ data: { ...data, attempt: 5 }, startAfter: 60 }]);
    expect(fake.downloads).toHaveLength(0);
  });

  it('stops after the maximum number of attempts', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.exports = [{ reportId: 7, status: 'Queued' }];
    const { deps, enqueued } = setup(fake);
    await runT212ExportJob(deps, {
      householdId,
      connectionId: id,
      reportId: 7,
      through: '2026-10-28',
      attempt: T212_MAX_ATTEMPTS - 1,
    });
    expect(enqueued).toHaveLength(0);
  });

  it.each(['Failed', 'Canceled', 'missing'])('stops on a %s export', async (status) => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.exports = status === 'missing' ? [] : [{ reportId: 7, status }];
    const { deps, enqueued, applied } = setup(fake);
    await runT212ExportJob(deps, {
      householdId,
      connectionId: id,
      reportId: 7,
      through: '2026-10-28',
      attempt: 0,
    });
    expect(enqueued).toHaveLength(0);
    expect(applied).toHaveLength(0);
    expect(await description(householdId)).toBe('WITHDRAW ref-1');
  });

  it('re-enqueues the request later on a rate limit instead of failing', async () => {
    const { householdId, id } = await broker();
    const fake = fresh();
    fake.requestError = new ProviderRateLimitError(120);
    const { deps, enqueued } = setup(fake);
    await runT212ExportJob(deps, { householdId, connectionId: id, attempt: 0 });
    expect(enqueued).toEqual([
      { data: { householdId, connectionId: id, attempt: 1 }, startAfter: 120 },
    ]);
  });

  it('rejects an invalid payload', async () => {
    await expect(runT212ExportJob(setup(fresh()).deps, { nope: 1 })).rejects.toThrow(
      'Invalid t212-export job payload',
    );
  });
});
