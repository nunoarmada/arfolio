import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderAuthError, type Trading212Summary } from '@arfolio/connectors';
import { encryptSecret } from '@arfolio/core/server';
import { createDb, schema, type Db } from '@arfolio/db';
import type { ConnectorDeps } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createWorkerConnectors } from '../connectors.js';
import { QUEUES } from '../queues.js';
import { makeConfig } from '../test-config.js';
import { runConsentCheck } from './consent-check.js';
import { PRUNE_SYNC_DATA_CRON, runPruneSyncData } from './prune-sync-data.js';
import { enqueueDueSyncs } from './sync-scheduler.js';
import { registerSyncConnection, runSyncConnectionJob } from './sync-connection.js';

// The jobs log one line per run; keep the test output clean.
const logged = vi.hoisted(() => ({ error: [] as string[] }));
vi.mock('../log.js', () => ({
  log: {
    info: () => {},
    warn: () => {},
    error: (msg: string) => {
      logged.error.push(msg);
    },
  },
  errorMessage: () => 'error',
}));

const KEY = Buffer.alloc(32, 9);
const MIN = 60_000;

const summary: Trading212Summary = {
  externalUid: '77',
  currency: 'EUR',
  totalValue: 1_000,
  cash: 1_000,
  cashAvailableToTrade: 1_000,
  investmentsValue: 0,
};

describe('sync worker jobs', () => {
  let testDb: TestDb;
  let db: Db;
  let owner: Db;
  const ends: Array<() => Promise<void>> = [];
  const now = new Date('2026-10-18T12:00:00.000Z');

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

  async function household(): Promise<string> {
    const id = `hh_${randomUUID()}`;
    await owner
      .insert(schema.organization)
      .values({ id, name: 'Test', slug: id, createdAt: new Date() });
    await owner.insert(schema.householdSettings).values({ householdId: id });
    return id;
  }

  /** A Trading 212 connection with a linked account, inserted directly as the table owner. */
  async function broker(patch: Partial<typeof schema.connection.$inferInsert> = {}) {
    const householdId = await household();
    const id = randomUUID();
    const accountId = randomUUID();
    await owner.insert(schema.financialAccount).values({
      id: accountId,
      householdId,
      name: 'Trading 212',
      type: 'investment',
      currency: 'EUR',
    });
    await owner.insert(schema.connection).values({
      id,
      householdId,
      provider: 'trading212',
      displayName: 'Broker',
      status: 'active',
      credentialsEnc: encryptSecret(
        JSON.stringify({ apiKey: 'k', apiSecret: 's' }),
        KEY,
        `connection:${id}:credentials`,
      ),
      createdBy: 'u',
      nextSyncAt: new Date(now.getTime() - MIN),
      ...patch,
    });
    await owner.insert(schema.connectionAccount).values({
      householdId,
      connectionId: id,
      accountId,
      externalUid: '77',
      externalKey: '77',
      currency: 'EUR',
      name: 'Trading 212',
    });
    return { householdId, id, accountId };
  }

  function deps(overrides: Partial<ConnectorDeps> = {}): ConnectorDeps {
    return {
      encryptionKey: KEY,
      trading212: () => ({
        getAccountSummary: async () => summary,
        getPositions: async () => [],
        listPies: async () => [],
        getPieDetail: async () => ({ name: 'Pie', instruments: [] }),
        listTransactions: async () => ({ items: [], incomplete: false }),
        listDividends: async () => ({ items: [], incomplete: false }),
      }),
      now: () => now,
      ...overrides,
    };
  }

  describe('sync scheduler', () => {
    it('enqueues one job per due active connection, with its household and trigger', async () => {
      const due = await broker();
      const later = await broker({ nextSyncAt: new Date(now.getTime() + MIN) });
      const expired = await broker({ status: 'expired' });
      const sent: Array<{ name: string; data: unknown; options: unknown }> = [];

      const count = await enqueueDueSyncs(
        db,
        async (name, data, options) => {
          sent.push({ name, data, options });
        },
        now,
      );

      const ids: string[] = [due.id, later.id, expired.id];
      const mine = sent.filter((s) =>
        ids.includes((s.data as { connectionId: string }).connectionId),
      );
      expect(count).toBe(sent.length);
      expect(mine).toEqual([
        {
          name: QUEUES.syncConnection,
          data: { householdId: due.householdId, connectionId: due.id, trigger: 'initial' },
          // One queued job per connection: a slow queue cannot pile up duplicates.
          options: { singletonKey: due.id },
        },
      ]);
    });
  });

  describe('sync-connection job', () => {
    it('runs the sync for the job payload', async () => {
      const c = await broker();
      await runSyncConnectionJob(
        { ...deps(), db, random: () => 0 },
        { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
      );
      const runs = await owner
        .select()
        .from(schema.syncRun)
        .where(eq(schema.syncRun.connectionId, c.id));
      expect(runs).toMatchObject([{ status: 'success', trigger: 'scheduled' }]);
    });

    it('resolves the connectors for each job, so a changed integration config applies without a restart', async () => {
      const c = await broker();
      const handlers = new Map<string, (jobs: unknown[]) => Promise<void>>();
      const boss = {
        createQueue: async () => {},
        work: async (n: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) =>
          void handlers.set(n, h),
      } as unknown as PgBoss;
      const getConnectors = vi.fn(async () => deps());
      await registerSyncConnection(boss, db, getConnectors);
      expect(getConnectors).not.toHaveBeenCalled();
      const job = {
        data: { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
      };
      await handlers.get(QUEUES.syncConnection)!([job]);
      await handlers.get(QUEUES.syncConnection)!([job]);
      expect(getConnectors).toHaveBeenCalledTimes(2);
      const runs = await owner
        .select()
        .from(schema.syncRun)
        .where(eq(schema.syncRun.connectionId, c.id));
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });

    it('records a failed run and resolves, so pg-boss does not retry against the provider', async () => {
      const c = await broker();
      const failing = deps({
        trading212: () => ({
          getAccountSummary: async () => {
            throw new ProviderAuthError();
          },
          getPositions: async () => [],
          listPies: async () => [],
          getPieDetail: async () => ({ name: 'Pie', instruments: [] }),
          listTransactions: async () => ({ items: [], incomplete: false }),
          listDividends: async () => ({ items: [], incomplete: false }),
        }),
      });
      await expect(
        runSyncConnectionJob(
          { ...failing, db },
          { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
        ),
      ).resolves.toBeUndefined();
      const [row] = await owner
        .select()
        .from(schema.connection)
        .where(eq(schema.connection.id, c.id));
      expect(row!.status).toBe('expired');
    });

    it('hands the household to the after-sync hook once a sync succeeds', async () => {
      const c = await broker();
      const after = vi.fn(async () => {});
      await runSyncConnectionJob(
        { ...deps(), db, random: () => 0 },
        { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
        after,
      );
      expect(after).toHaveBeenCalledExactlyOnceWith(c.householdId);
    });

    it('hands household and connection to the connection hook after a successful sync', async () => {
      const c = await broker();
      const hook = vi.fn(async () => {});
      await runSyncConnectionJob(
        { ...deps(), db, random: () => 0 },
        { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
        undefined,
        undefined,
        hook,
      );
      expect(hook).toHaveBeenCalledExactlyOnceWith(c.householdId, c.id);
    });

    it('survives a failing connection hook', async () => {
      const c = await broker();
      await expect(
        runSyncConnectionJob(
          { ...deps(), db, random: () => 0 },
          { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
          undefined,
          undefined,
          async () => {
            throw new Error('queue down');
          },
        ),
      ).resolves.toBeUndefined();
    });

    it('skips the hook for a failed or skipped sync, and survives a failing hook', async () => {
      const failed = await broker();
      const after = vi.fn(async () => {});
      const failing = deps({
        trading212: () => ({
          getAccountSummary: async () => {
            throw new ProviderAuthError();
          },
          getPositions: async () => [],
          listPies: async () => [],
          getPieDetail: async () => ({ name: 'Pie', instruments: [] }),
          listTransactions: async () => ({ items: [], incomplete: false }),
          listDividends: async () => ({ items: [], incomplete: false }),
        }),
      });
      await runSyncConnectionJob(
        { ...failing, db },
        { householdId: failed.householdId, connectionId: failed.id, trigger: 'scheduled' },
        after,
      );
      const later = await broker({ nextSyncAt: new Date(now.getTime() + MIN) });
      await runSyncConnectionJob(
        { ...deps(), db },
        { householdId: later.householdId, connectionId: later.id, trigger: 'scheduled' },
        after,
      );
      expect(after).not.toHaveBeenCalled();

      const ok = await broker();
      await expect(
        runSyncConnectionJob(
          { ...deps(), db, random: () => 0 },
          { householdId: ok.householdId, connectionId: ok.id, trigger: 'scheduled' },
          async () => {
            throw new Error('queue down');
          },
        ),
      ).resolves.toBeUndefined();
    });

    it('queues push delivery after a failed sync (sync_failing), a success, and before rethrowing', async () => {
      const notify = vi.fn(async () => {});
      const failing = deps({
        trading212: () => ({
          getAccountSummary: async () => {
            throw new ProviderAuthError();
          },
          getPositions: async () => [],
          listPies: async () => [],
          getPieDetail: async () => ({ name: 'Pie', instruments: [] }),
          listTransactions: async () => ({ items: [], incomplete: false }),
          listDividends: async () => ({ items: [], incomplete: false }),
        }),
      });
      const failed = await broker();
      await runSyncConnectionJob(
        { ...failing, db },
        { householdId: failed.householdId, connectionId: failed.id, trigger: 'scheduled' },
        undefined,
        notify,
      );
      expect(notify).toHaveBeenCalledTimes(1);

      const ok = await broker();
      await runSyncConnectionJob(
        { ...deps(), db, random: () => 0 },
        { householdId: ok.householdId, connectionId: ok.id, trigger: 'scheduled' },
        undefined,
        notify,
      );
      expect(notify).toHaveBeenCalledTimes(2);

      // an unexpected error still rethrows, after asking for delivery
      const c = await broker();
      await expect(
        runSyncConnectionJob(
          { ...deps(), db: {} as Db },
          { householdId: c.householdId, connectionId: c.id, trigger: 'scheduled' },
          undefined,
          notify,
        ),
      ).rejects.toThrow();
      expect(notify).toHaveBeenCalledTimes(3);
    });

    it('does not queue push delivery for a skipped sync', async () => {
      const notify = vi.fn(async () => {});
      const later = await broker({ nextSyncAt: new Date(now.getTime() + MIN) });
      await runSyncConnectionJob(
        { ...deps(), db },
        { householdId: later.householdId, connectionId: later.id, trigger: 'scheduled' },
        undefined,
        notify,
      );
      expect(notify).not.toHaveBeenCalled();
    });

    it('rejects a malformed payload', async () => {
      await expect(
        runSyncConnectionJob(
          { ...deps(), db },
          { householdId: '', connectionId: 'x', trigger: 'nope' },
        ),
      ).rejects.toThrow(/Invalid sync job/);
    });
  });

  describe('consent-check job', () => {
    it('notifies for consents ending within a week', async () => {
      const c = await broker({
        provider: 'enablebanking',
        credentialsEnc: null,
        externalSessionIdEnc: 'x',
        consentExpiresAt: new Date(now.getTime() + 3 * 86_400_000),
      });
      const totals = await runConsentCheck(db, now);
      expect(totals.expiring).toBeGreaterThanOrEqual(1);
      const rows = await owner
        .select()
        .from(schema.notification)
        .where(eq(schema.notification.householdId, c.householdId));
      expect(rows.map((r) => r.kind)).toEqual(['consent_expiring']);
    });
  });

  describe('prune-sync-data job', () => {
    it('deletes consent states older than a day and sync runs older than 180 days', async () => {
      const c = await broker();
      const day = 86_400_000;
      await owner.insert(schema.syncRun).values([
        {
          householdId: c.householdId,
          connectionId: c.id,
          trigger: 'scheduled',
          status: 'success',
          startedAt: new Date(now.getTime() - 200 * day),
        },
        {
          householdId: c.householdId,
          connectionId: c.id,
          trigger: 'scheduled',
          status: 'success',
          startedAt: new Date(now.getTime() - 10 * day),
        },
      ]);
      await owner.insert(schema.consentState).values({
        householdId: c.householdId,
        stateHash: randomUUID(),
        userId: 'u',
        aspspName: 'Bank',
        aspspCountry: 'PT',
        expiresAt: new Date(now.getTime() - 2 * day),
        createdAt: new Date(now.getTime() - 2 * day),
      });

      const totals = await runPruneSyncData(db, now);

      expect(totals.syncRuns).toBeGreaterThanOrEqual(1);
      expect(totals.consentStates).toBeGreaterThanOrEqual(1);
      const runs = await owner
        .select()
        .from(schema.syncRun)
        .where(eq(schema.syncRun.connectionId, c.id));
      expect(runs).toHaveLength(1);
      expect(
        await owner
          .select()
          .from(schema.consentState)
          .where(eq(schema.consentState.householdId, c.householdId)),
      ).toEqual([]);
    });

    it('runs once a day', () => {
      expect(PRUNE_SYNC_DATA_CRON.split(' ').slice(2)).toEqual(['*', '*', '*']);
    });
  });

  describe('createWorkerConnectors', () => {
    const base = { encryptionKey: Buffer.alloc(32, 7) };
    const pem = () =>
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    const bankCfg = (privateKey: string, appId = 'app', apiUrl?: string) =>
      makeConfig({ enableBanking: { appId, privateKey, ...(apiUrl ? { apiUrl } : {}) } });

    it('has no bank client without Enable Banking credentials', () => {
      const d = createWorkerConnectors(base)(makeConfig());
      expect(d.enableBanking).toBeUndefined();
      expect(d.encryptionKey).toBe(base.encryptionKey);
      expect(typeof d.trading212({ apiKey: 'a', apiSecret: 'b' }).getAccountSummary).toBe(
        'function',
      );
    });

    it('points Trading 212 at TRADING212_API_URL when set, and at the live API otherwise', async () => {
      const urls: string[] = [];
      const fetchStub = vi.fn((url: string | URL | Request) => {
        urls.push(String(url));
        return Promise.resolve(new Response('{}', { status: 500 }));
      });
      vi.stubGlobal('fetch', fetchStub);
      try {
        const call = (opts: Parameters<typeof createWorkerConnectors>[0]) =>
          createWorkerConnectors(opts)(makeConfig())
            .trading212({ apiKey: 'a', apiSecret: 'b' })
            .getAccountSummary()
            .catch(() => undefined);
        await call(base);
        await call({ ...base, trading212ApiUrl: 'http://127.0.0.1:9/api/v0' });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(urls).toEqual([
        'https://live.trading212.com/api/v0/equity/account/summary',
        'http://127.0.0.1:9/api/v0/equity/account/summary',
      ]);
    });

    it('builds the bank client when the installation is configured', () => {
      const d = createWorkerConnectors(base)(bankCfg(pem()));
      expect(typeof d.enableBanking?.startAuth).toBe('function');
    });

    it('keeps the bank client while its config is unchanged and rebuilds it when it changes', () => {
      const key = pem();
      const get = createWorkerConnectors(base);
      const first = get(bankCfg(key)).enableBanking;
      expect(first).toBeDefined();
      expect(get(bankCfg(key)).enableBanking).toBe(first);
      const otherApp = get(bankCfg(key, 'app-2')).enableBanking;
      expect(otherApp).not.toBe(first);
      const otherUrl = get(bankCfg(key, 'app-2', 'https://sandbox.example.org')).enableBanking;
      expect(otherUrl).not.toBe(otherApp);
      const otherKey = get(bankCfg(pem(), 'app-2', 'https://sandbox.example.org')).enableBanking;
      expect(otherKey).not.toBe(otherUrl);
    });

    it('starts offering banking when credentials appear later, and stops when they go', () => {
      const get = createWorkerConnectors(base);
      expect(get(makeConfig()).enableBanking).toBeUndefined();
      expect(get(bankCfg(pem())).enableBanking).toBeDefined();
      expect(get(makeConfig()).enableBanking).toBeUndefined();
    });

    it('treats a malformed private key as banking disabled for the run, without logging the key', () => {
      logged.error.length = 0;
      const get = createWorkerConnectors(base);
      const bad = bankCfg(
        '-----BEGIN PRIVATE KEY-----\ngarbage-garbage\n-----END PRIVATE KEY-----',
      );
      const d = get(bad);
      expect(d.enableBanking).toBeUndefined();
      expect(typeof d.trading212({ apiKey: 'a', apiSecret: 'b' }).getAccountSummary).toBe(
        'function',
      );
      expect(logged.error).toHaveLength(1);
      expect(logged.error[0]).toContain('Enable Banking private key');
      expect(logged.error[0]).not.toContain('garbage');
    });

    it('logs a bad key once per distinct config value, not once per run', () => {
      logged.error.length = 0;
      const get = createWorkerConnectors(base);
      const bad = (n: number) =>
        bankCfg(`-----BEGIN PRIVATE KEY-----\nbad-${n}\n-----END PRIVATE KEY-----`);
      for (let run = 0; run < 5; run++) expect(get(bad(1)).enableBanking).toBeUndefined();
      expect(logged.error).toHaveLength(1);
      get(bad(2));
      get(bad(2));
      expect(logged.error).toHaveLength(2);
      // fixing the key then breaking it again with the same value is a new event
      get(bankCfg(pem()));
      get(bad(1));
      expect(logged.error).toHaveLength(3);
    });
  });
});
