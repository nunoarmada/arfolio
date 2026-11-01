import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderAuthError,
  ProviderResponseError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type ProviderPosition,
} from '@arfolio/connectors';
import { schema } from '@arfolio/db';
import {
  addTrading212Connection,
  completeBankConsent,
  computeNextSyncAt,
  findDueConnections,
  ForbiddenError,
  linkConnectionAccounts,
  listConnections,
  ManualRefreshLimitError,
  NotFoundError,
  removeConnection,
  requestManualSync,
  startBankConsent,
  syncConnection,
  type ServiceCtx,
  type SyncDeps,
} from '../src/index.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  fakeBanking,
  fakeTrading212,
  makeDeps,
  tx,
  type FakeBanking,
  type FakeTrading212,
} from './connector-fakes.js';
import { syncLockKey } from '../src/internal.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const {
  balanceSnapshot,
  connection,
  connectionAccount,
  investmentBucket,
  investmentBucketSnapshot,
  notification,
  positionSnapshot,
  syncRun,
  transaction,
} = schema;

const DAY = 86_400_000;
const MIN = 60_000;

describe('computeNextSyncAt', () => {
  const at = (iso: string, timezone: string, extra: object = {}) =>
    computeNextSyncAt({ now: new Date(iso), timezone, random: () => 0, ...extra }).toISOString();

  it('is the next 06:00 in the household timezone', () => {
    expect(at('2026-10-18T03:00:00Z', 'UTC')).toBe('2026-10-18T06:00:00.000Z');
    expect(at('2026-10-18T06:00:00Z', 'UTC')).toBe('2026-10-19T06:00:00.000Z');
    expect(at('2026-07-01T12:00:00Z', 'Europe/Lisbon')).toBe('2026-07-02T05:00:00.000Z');
    expect(at('2026-01-10T12:00:00Z', 'Europe/Lisbon')).toBe('2026-01-11T06:00:00.000Z');
  });

  it('follows the clock across the spring-forward DST boundary', () => {
    // Lisbon moves 01:00Z on 2027-03-28: 06:00 local is 06:00Z the day before, 05:00Z after.
    expect(at('2027-03-27T07:00:00Z', 'Europe/Lisbon')).toBe('2027-03-28T05:00:00.000Z');
    expect(at('2027-03-28T05:30:00Z', 'Europe/Lisbon')).toBe('2027-03-29T05:00:00.000Z');
  });

  it('follows the clock across the fall-back DST boundary', () => {
    // Lisbon moves back 01:00Z on 2026-10-25: 06:00 local is 05:00Z before, 06:00Z after.
    expect(at('2026-10-24T07:00:00Z', 'Europe/Lisbon')).toBe('2026-10-25T06:00:00.000Z');
    expect(at('2026-10-23T07:00:00Z', 'Europe/Lisbon')).toBe('2026-10-24T05:00:00.000Z');
  });

  it('adds up to 20 minutes of jitter and honours a custom hour', () => {
    expect(at('2026-10-18T03:00:00Z', 'UTC', { random: () => 0.5 })).toBe(
      '2026-10-18T06:10:00.000Z',
    );
    const max = computeNextSyncAt({
      now: new Date('2026-10-18T03:00:00Z'),
      timezone: 'UTC',
      random: () => 0.999999,
    });
    expect(max.getTime() - Date.parse('2026-10-18T06:00:00Z')).toBeLessThan(20 * MIN);
    expect(at('2026-10-18T03:00:00Z', 'UTC', { syncHour: 8 })).toBe('2026-10-18T08:00:00.000Z');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(at('2026-10-18T03:00:00Z', 'Not/AZone')).toBe('2026-10-18T06:00:00.000Z');
  });
});

describe('sync engine', () => {
  let t: ServicesTestDb;
  let now: Date;
  const clock = () => now;

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(() => t.close());

  const syncDeps = (
    banking: FakeBanking | undefined,
    t212: FakeTrading212 | undefined,
    extra: Partial<SyncDeps> = {},
  ) => ({ ...makeDeps(banking, t212, clock), db: t.db, random: () => 0, ...extra });

  /** A household with an active bank connection linked to `n` accounts (uids uid-1..uid-n). */
  async function bank(n: number, opts: { timezone?: string } = {}) {
    now = new Date('2026-10-18T12:00:00.000Z');
    const ctx = await t.household();
    if (opts.timezone) {
      await t.owner
        .update(schema.householdSettings)
        .set({ timezone: opts.timezone })
        .where(eq(schema.householdSettings.householdId, ctx.householdId));
    }
    const banking = fakeBanking();
    banking.sessionAccounts = Array.from({ length: n }, (_, i) => ({
      ...(i === 0 ? ACCOUNT_A : ACCOUNT_B),
      externalUid: `uid-${i + 1}`,
      externalKey: `key-${i + 1}`,
      name: `Acc ${i + 1}`,
    }));
    const deps = syncDeps(banking, undefined);
    await startBankConsent(ctx, deps, { aspspName: 'Test Bank', country: 'PT' });
    const { connectionId } = await completeBankConsent(ctx, deps, {
      state: banking.states[0]!,
      code: 'c',
    });
    await linkConnectionAccounts(
      ctx,
      deps,
      connectionId,
      banking.sessionAccounts.map((a) => ({
        externalKey: a.externalKey,
        create: { name: a.name, type: 'checking' as const },
      })),
    );
    // "Consent start" is the connection's creation: keep it well in the past unless a test says otherwise.
    await t.owner
      .update(connection)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z'), nextSyncAt: null })
      .where(eq(connection.id, connectionId));
    const links = await t.owner
      .select()
      .from(connectionAccount)
      .where(eq(connectionAccount.connectionId, connectionId))
      .orderBy(connectionAccount.externalKey);
    return { ctx, banking, deps, connectionId, links };
  }

  async function broker(opts: { positions?: ProviderPosition[] } = {}) {
    now = new Date('2026-10-18T12:00:00.000Z');
    const ctx = await t.household();
    const t212 = fakeTrading212();
    t212.positions = opts.positions ?? [];
    const deps = syncDeps(undefined, t212);
    const { connectionId } = await addTrading212Connection(ctx, deps, {
      apiKey: 'plain-key',
      apiSecret: 'plain-secret',
      displayName: 'Broker',
    });
    await linkConnectionAccounts(ctx, deps, connectionId, [
      { externalKey: '4242', create: { name: 'Trading 212', type: 'investment' } },
    ]);
    await t.owner
      .update(connection)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z'), nextSyncAt: null })
      .where(eq(connection.id, connectionId));
    return { ctx, t212, deps, connectionId };
  }

  /** Makes the connection due now (a finished run schedules the next one for tomorrow). */
  const makeDue = (id: string) =>
    t.owner
      .update(connection)
      .set({ nextSyncAt: new Date(now.getTime() - MIN) })
      .where(eq(connection.id, id));
  const conn = async (id: string) =>
    (await t.owner.select().from(connection).where(eq(connection.id, id)))[0]!;
  const runs = (id: string) =>
    t.owner.select().from(syncRun).where(eq(syncRun.connectionId, id)).orderBy(syncRun.startedAt);
  const txCount = async (accountId: string) =>
    (await t.owner.select().from(transaction).where(eq(transaction.accountId, accountId))).length;
  const notifications = (ctx: ServiceCtx) =>
    t.owner.select().from(notification).where(eq(notification.householdId, ctx.householdId));

  describe('Enable Banking', () => {
    it('ingests transactions and balances per account and records the run', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(2);
      banking.txs['uid-1'] = [
        tx({ externalId: 'a1' }),
        tx({ externalId: 'a2', amount: -500, description: 'Bakery' }),
      ];
      banking.txs['uid-2'] = [tx({ externalId: 'b1', amount: 90_000, description: 'Salary' })];
      banking.balances['uid-1'] = [
        {
          externalUid: 'uid-1',
          asOf: '2026-10-18',
          amount: 123_456,
          currency: 'EUR',
          kind: 'CLBD',
        },
        {
          externalUid: 'uid-1',
          asOf: '2026-10-18',
          amount: 120_000,
          currency: 'EUR',
          kind: 'ITAV',
        },
      ];

      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });

      expect(result).toMatchObject({
        status: 'success',
        inserted: 3,
        duplicates: 0,
        providerCalls: 4,
        errorCode: null,
      });
      expect(await txCount(links[0]!.accountId)).toBe(2);
      expect(await txCount(links[1]!.accountId)).toBe(1);
      const [src] = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.accountId, links[0]!.accountId))
        .limit(1);
      expect(src!.source).toBe('connector');
      const snaps = await t.owner
        .select()
        .from(balanceSnapshot)
        .where(eq(balanceSnapshot.accountId, links[0]!.accountId));
      expect(snaps.map((s) => [s.source, s.asOf, s.balance]).sort()).toEqual([
        ['enablebanking:CLBD', '2026-10-18', 123_456],
        ['enablebanking:ITAV', '2026-10-18', 120_000],
      ]);

      const [run] = await runs(connectionId);
      expect(run).toMatchObject({
        status: 'success',
        trigger: 'scheduled',
        inserted: 3,
        providerCalls: 4,
        errorCode: null,
        errorMessage: null,
      });
      expect(run!.finishedAt).not.toBeNull();
      const row = await conn(connectionId);
      expect(row.lastSuccessAt?.toISOString()).toBe(now.toISOString());
      expect(row.lastSyncAt?.toISOString()).toBe(now.toISOString());
      expect(row.consecutiveFailures).toBe(0);
      expect(row.nextSyncAt?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    });

    it('counts every transaction page as a provider call', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      banking.pages['uid-1'] = 3;
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      // 3 pages + balances for the first account, 1 page + balances for the second.
      expect(result).toMatchObject({ status: 'success', providerCalls: 6 });
      expect((await runs(connectionId))[0]).toMatchObject({ providerCalls: 6 });
    });

    it('stores available balances as of the sync day and date-time balances on the household local day', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1, {
        timezone: 'Europe/Lisbon',
      });
      // 23:30Z is already the 19th in Lisbon (UTC+1 until 25 October).
      now = new Date('2026-10-18T23:30:00.000Z');
      const bal = (kind: string, asOf: string, amount: number) => ({
        externalUid: 'uid-1',
        asOf,
        amount,
        currency: 'EUR',
        kind,
      });
      banking.balances['uid-1'] = [
        bal('ITAV', '2026-10-16T08:00:00Z', 100),
        bal('CLAV', '2026-10-16', 200),
        bal('CLBD', '2026-10-18T23:10:00Z', 300),
        bal('XPCD', '2026-10-17', 400),
      ];
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'manual',
      });
      const snaps = await t.owner
        .select()
        .from(balanceSnapshot)
        .where(eq(balanceSnapshot.accountId, links[0]!.accountId));
      expect(snaps.map((x) => [x.source, x.asOf, x.balance]).sort()).toEqual([
        ['enablebanking:CLAV', '2026-10-19', 200],
        ['enablebanking:CLBD', '2026-10-19', 300],
        ['enablebanking:ITAV', '2026-10-19', 100],
        ['enablebanking:XPCD', '2026-10-17', 400],
      ]);
    });

    it('schedules the next run at the household sync hour in its timezone, with jitter', async () => {
      const { ctx, deps, connectionId } = await bank(1, { timezone: 'Europe/Lisbon' });
      now = new Date('2026-07-01T12:00:00.000Z');
      await syncConnection(
        { ...deps, random: () => 0.5 },
        { householdId: ctx.householdId, connectionId, trigger: 'scheduled' },
      );
      expect((await conn(connectionId)).nextSyncAt?.toISOString()).toBe('2026-07-02T05:10:00.000Z');
    });

    it('asks for 89 days first (the bank rejects exactly 90), then from last success minus 7 days (never before the connection existed)', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      await syncConnection(deps, input);
      expect(banking.txRanges.at(-1)).toEqual({
        uid: 'uid-1',
        dateFrom: '2026-07-21',
        dateTo: '2026-10-18',
      });

      now = new Date(now.getTime() + 2 * DAY);
      await syncConnection(deps, input);
      expect(banking.txRanges.at(-1)).toEqual({
        uid: 'uid-1',
        dateFrom: '2026-10-11',
        dateTo: '2026-10-20',
      });

      await t.owner
        .update(connection)
        .set({ createdAt: new Date('2026-10-16T08:00:00Z') })
        .where(eq(connection.id, connectionId));
      now = new Date(now.getTime() + 5 * 60 * MIN);
      await makeDue(connectionId);
      await syncConnection(deps, { ...input, trigger: 'scheduled' });
      expect(banking.txRanges.at(-1)!.dateFrom).toBe('2026-10-16');
    });

    it('an account linked after the last success gets the full first window; the others keep the overlap', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      await linkConnectionAccounts(ctx, deps, connectionId, [
        { externalKey: 'key-2', ignore: true },
      ]);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      await syncConnection(deps, input);
      expect(banking.txRanges.map((r) => r.uid)).toEqual(['uid-1']);

      now = new Date(now.getTime() + 2 * DAY);
      await linkConnectionAccounts(ctx, deps, connectionId, [
        { externalKey: 'key-2', create: { name: 'Added later', type: 'savings' } },
      ]);
      banking.txRanges.length = 0;
      await syncConnection(deps, input);
      expect(banking.txRanges).toEqual([
        { uid: 'uid-1', dateFrom: '2026-10-11', dateTo: '2026-10-20' },
        { uid: 'uid-2', dateFrom: '2026-07-23', dateTo: '2026-10-20' },
      ]);

      // Once synced, the new account joins the normal overlap window.
      now = new Date(now.getTime() + DAY);
      banking.txRanges.length = 0;
      await syncConnection(deps, input);
      expect(banking.txRanges.map((r) => r.dateFrom)).toEqual(['2026-10-13', '2026-10-13']);
    });

    it('a failure on the third account keeps last_success_at unset; the re-run completes without duplicates', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(3);
      banking.txs['uid-1'] = [tx({ externalId: 'p1' })];
      banking.txs['uid-2'] = [tx({ externalId: 'p2', description: 'Second' })];
      banking.txs['uid-3'] = (call) => {
        if (call === 1) throw new ProviderUnavailableError('page 3 failed');
        return [tx({ externalId: 'p3', description: 'Third' })];
      };
      const input = { householdId: ctx.householdId, connectionId, trigger: 'scheduled' as const };

      const failed = await syncConnection(deps, input);
      expect(failed).toMatchObject({ status: 'partial', inserted: 2, errorCode: 'unavailable' });
      const afterFail = await conn(connectionId);
      expect(afterFail.lastSuccessAt).toBeNull();
      expect(afterFail.consecutiveFailures).toBe(1);
      expect(afterFail.lastErrorCode).toBe('unavailable');
      expect(afterFail.status).toBe('active');
      expect(await notifications(ctx)).toEqual([]);

      now = new Date(now.getTime() + DAY);
      const rerun = await syncConnection(deps, input);
      expect(rerun).toMatchObject({ status: 'success', inserted: 1, duplicates: 2 });
      for (const l of links) expect(await txCount(l.accountId)).toBe(1);
      const ok = await conn(connectionId);
      expect(ok.lastSuccessAt).not.toBeNull();
      expect(ok).toMatchObject({
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect((await runs(connectionId)).map((r) => r.status)).toEqual(['partial', 'success']);
    });

    it('removes a pending row the bank no longer reports once its booked version arrived under another id', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      banking.txs['uid-1'] = [
        tx({ externalId: 'pp1', status: 'pending', bookingDate: '2026-10-17' }),
      ];
      await syncConnection(deps, input);
      expect(await txCount(links[0]!.accountId)).toBe(1);

      now = new Date(now.getTime() + DAY);
      banking.txs['uid-1'] = [
        tx({ externalId: 'bb1', status: 'booked', bookingDate: '2026-10-18' }),
      ];
      expect(await syncConnection(deps, input)).toMatchObject({ status: 'success', inserted: 1 });
      const rows = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.accountId, links[0]!.accountId));
      expect(rows.map((r) => [r.externalId, r.status])).toEqual([['bb1', 'booked']]);
    });

    it('keeps pending rows when the bank returns nothing, or some rows were unreadable, or they sit at the window edge', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'scheduled' as const };
      const pend = (id: string, bookingDate: string) =>
        tx({ externalId: id, status: 'pending', bookingDate, description: id });
      banking.txs['uid-1'] = [pend('edge', '2026-10-12'), pend('mid', '2026-10-16')];
      await syncConnection(deps, input);
      expect(await txCount(links[0]!.accountId)).toBe(2);

      now = new Date(now.getTime() + 21 * 60 * MIN);
      await makeDue(connectionId);
      // An empty answer proves nothing.
      banking.txs['uid-1'] = [];
      await syncConnection(deps, input);
      expect(await txCount(links[0]!.accountId)).toBe(2);

      // Unreadable rows may have been the pending ones.
      banking.txs['uid-1'] = [tx({ externalId: 'other', description: 'Other' })];
      banking.skippedRows['uid-1'] = 1;
      now = new Date(now.getTime() + 21 * 60 * MIN);
      await makeDue(connectionId);
      await syncConnection(deps, input);
      expect(await txCount(links[0]!.accountId)).toBe(3);

      // A clean answer expires 'mid' but not 'edge' (within two days of the window start).
      banking.skippedRows['uid-1'] = 0;
      now = new Date(now.getTime() + 21 * 60 * MIN);
      await makeDue(connectionId);
      await syncConnection(deps, input);
      const left = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.accountId, links[0]!.accountId));
      expect(left.map((r) => r.externalId).sort()).toEqual(['edge', 'other']);
    });

    it('keeps pending rows when the account fails to sync', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      banking.txs['uid-1'] = [
        tx({ externalId: 'pp2', status: 'pending', bookingDate: '2026-10-17' }),
      ];
      await syncConnection(deps, input);
      now = new Date(now.getTime() + DAY);
      banking.txs['uid-1'] = () => {
        throw new ProviderUnavailableError('down');
      };
      await syncConnection(deps, input);
      expect(await txCount(links[0]!.accountId)).toBe(1);
    });

    it('re-running the same window inserts nothing new', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1);
      banking.txs['uid-1'] = [tx({ externalId: 'x1' }), tx({ externalId: 'x2', amount: -2 })];
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      await syncConnection(deps, input);
      const again = await syncConnection(deps, input);
      expect(again).toMatchObject({ status: 'success', inserted: 0, duplicates: 2 });
      expect(await txCount(links[0]!.accountId)).toBe(2);
    });

    it('expires the connection and notifies once when the provider rejects the consent', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      banking.txs['uid-1'] = () => {
        throw new ProviderAuthError();
      };
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'auth' });
      expect(banking.calls.filter((c) => c.startsWith('listTransactions'))).toHaveLength(1);
      const row = await conn(connectionId);
      expect(row).toMatchObject({ status: 'expired', nextSyncAt: null, lastErrorCode: 'auth' });
      expect(row.lastSuccessAt).toBeNull();
      const rows = await notifications(ctx);
      expect(rows.map((r) => [r.kind, r.dedupeKey])).toEqual([
        ['consent_expired', `consent-expired:${connectionId}:2027-01-15`],
      ]);

      // Nothing is attempted against an expired connection.
      const again = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(again).toEqual({ status: 'skipped', reason: 'inactive' });
      expect(await notifications(ctx)).toHaveLength(1);
    });

    it('expires without calling the provider when the consent date has passed', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      await t.owner
        .update(connection)
        .set({ consentExpiresAt: new Date(now.getTime() - MIN) })
        .where(eq(connection.id, connectionId));
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(result).toMatchObject({
        status: 'failed',
        errorCode: 'consent_expired',
        providerCalls: 0,
      });
      expect(banking.calls.filter((c) => c.startsWith('listTransactions'))).toEqual([]);
      expect((await conn(connectionId)).status).toBe('expired');
      expect((await notifications(ctx)).map((r) => r.dedupeKey)).toEqual([
        `consent-expired:${connectionId}:2026-10-18`,
      ]);
    });

    it('notifies after 2 consecutive failures, once per day, and stops at a rate limit', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      banking.txs['uid-1'] = () => {
        throw new ProviderRateLimitError(30);
      };
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };

      expect(await syncConnection(deps, input)).toMatchObject({
        status: 'failed',
        errorCode: 'rate_limited',
      });
      // The rate limit ends the run: the second account is not tried.
      expect(banking.calls.filter((c) => c.startsWith('listTransactions'))).toHaveLength(1);
      expect(await notifications(ctx)).toEqual([]);

      now = new Date(now.getTime() + MIN);
      await makeDue(connectionId);
      await syncConnection(deps, { ...input, trigger: 'scheduled' });
      const rows = await notifications(ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'sync_failing',
        dedupeKey: `sync-failing:${connectionId}:2026-10-18`,
      });

      now = new Date(now.getTime() + MIN);
      await makeDue(connectionId);
      await syncConnection(deps, { ...input, trigger: 'scheduled' });
      expect(await notifications(ctx)).toHaveLength(1);
      expect((await conn(connectionId)).consecutiveFailures).toBe(3);

      now = new Date(now.getTime() + DAY);
      await makeDue(connectionId);
      await syncConnection(deps, { ...input, trigger: 'scheduled' });
      expect((await notifications(ctx)).map((r) => r.dedupeKey).sort()).toEqual([
        `sync-failing:${connectionId}:2026-10-18`,
        `sync-failing:${connectionId}:2026-10-19`,
      ]);
    });

    it('retries one transient failure about 3 hours later, then waits for the next daily slot', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      banking.txs['uid-1'] = () => {
        throw new ProviderUnavailableError('down');
      };
      const input = { householdId: ctx.householdId, connectionId, trigger: 'scheduled' as const };
      await syncConnection(deps, input);
      expect((await conn(connectionId)).nextSyncAt?.toISOString()).toBe('2026-10-18T15:00:00.000Z');

      now = new Date('2026-10-18T15:00:00.000Z');
      await syncConnection(deps, input);
      expect(await conn(connectionId)).toMatchObject({ consecutiveFailures: 2 });
      expect((await conn(connectionId)).nextSyncAt?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    });

    it('does not retry sooner when the failed run already spent more than one call per account', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      banking.pages['uid-1'] = 2;
      banking.txs['uid-1'] = () => {
        throw new ProviderUnavailableError('down on page 2');
      };
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect((await conn(connectionId)).nextSyncAt?.toISOString()).toBe('2026-10-19T06:00:00.000Z');
    });

    it('does not retry sooner after a rate limit, a partial run or when the daily slot comes first', async () => {
      const limited = await bank(1);
      limited.banking.txs['uid-1'] = () => {
        throw new ProviderRateLimitError(30);
      };
      await syncConnection(limited.deps, {
        householdId: limited.ctx.householdId,
        connectionId: limited.connectionId,
        trigger: 'scheduled',
      });
      expect((await conn(limited.connectionId)).nextSyncAt?.toISOString()).toBe(
        '2026-10-19T06:00:00.000Z',
      );

      // One account synced: the bank budget for it is spent, so the whole run waits for tomorrow.
      const partial = await bank(2);
      partial.banking.txs['uid-2'] = () => {
        throw new ProviderUnavailableError('down');
      };
      expect(
        await syncConnection(partial.deps, {
          householdId: partial.ctx.householdId,
          connectionId: partial.connectionId,
          trigger: 'scheduled',
        }),
      ).toMatchObject({ status: 'partial' });
      expect((await conn(partial.connectionId)).nextSyncAt?.toISOString()).toBe(
        '2026-10-19T06:00:00.000Z',
      );

      // At 04:00Z the daily slot (06:00Z) is sooner than 3 hours.
      const early = await bank(1);
      early.banking.txs['uid-1'] = () => {
        throw new ProviderUnavailableError('down');
      };
      now = new Date('2026-10-18T04:00:00.000Z');
      await syncConnection(early.deps, {
        householdId: early.ctx.householdId,
        connectionId: early.connectionId,
        trigger: 'scheduled',
      });
      expect((await conn(early.connectionId)).nextSyncAt?.toISOString()).toBe(
        '2026-10-18T06:00:00.000Z',
      );
    });

    it('stores a short code and safe message, never provider text or secrets', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      banking.txs['uid-1'] = () => {
        throw new Error('GET /sessions/session-1-secret failed with key=hunter2');
      };
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'manual',
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'internal' });
      const [run] = await runs(connectionId);
      const row = await conn(connectionId);
      for (const text of [
        run!.errorCode,
        run!.errorMessage,
        row.lastErrorCode,
        row.lastErrorMessage,
      ]) {
        expect(text).toBeTruthy();
        expect(text).not.toMatch(/session-1|hunter2|secret/);
      }
    });
  });

  describe('review fixes', () => {
    it('an account deleted while the run is in flight is skipped, not counted as a failure', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(2);
      banking.txs['uid-1'] = [tx({ externalId: 'gone-1' })];
      banking.txs['uid-2'] = [tx({ externalId: 'kept-1' })];
      banking.beforeTransactions = async (uid) => {
        if (uid !== 'uid-1') return;
        await t.owner
          .delete(schema.financialAccount)
          .where(eq(schema.financialAccount.id, links[0]!.accountId));
      };
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(result).toMatchObject({ status: 'success', inserted: 1, errorCode: null });
      expect((await conn(connectionId)).consecutiveFailures).toBe(0);
      expect(await txCount(links[1]!.accountId)).toBe(1);
    });

    it('raises a second expired notification after a renewal expires again', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      const input = { householdId: ctx.householdId, connectionId, trigger: 'manual' as const };
      banking.txs['uid-1'] = () => {
        throw new ProviderAuthError();
      };
      await syncConnection(deps, input);

      const renewing = fakeBanking(1);
      renewing.sessionAccounts = banking.sessionAccounts;
      renewing.validUntil = '2027-04-01T00:00:00.000Z';
      const renewDeps = syncDeps(renewing, undefined);
      await startBankConsent(ctx, renewDeps, {
        aspspName: 'Test Bank',
        country: 'PT',
        connectionId,
      });
      await completeBankConsent(ctx, renewDeps, { state: renewing.states[0]!, code: 'c' });
      expect((await conn(connectionId)).status).toBe('active');

      renewing.txs['uid-1'] = () => {
        throw new ProviderAuthError();
      };
      now = new Date(now.getTime() + MIN);
      await syncConnection(renewDeps, input);
      expect((await notifications(ctx)).map((n) => n.dedupeKey).sort()).toEqual([
        `consent-expired:${connectionId}:2027-01-15`,
        `consent-expired:${connectionId}:2027-04-01`,
      ]);
    });

    it('spends the slot when a run is claimed: a crash before the end does not loop every 15 minutes', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      await makeDue(connectionId);
      expect((await findDueConnections(t.db, now)).map((d) => d.connectionId)).toContain(
        connectionId,
      );
      let calls = 0;
      const crashing = {
        ...deps,
        random: () => {
          // The first call claims the run; the second is the end-of-run bookkeeping.
          if (++calls > 1) throw new Error('crash before finish');
          return 0;
        },
      };
      await expect(
        syncConnection(crashing, {
          householdId: ctx.householdId,
          connectionId,
          trigger: 'scheduled',
        }),
      ).rejects.toThrow('crash before finish');
      expect(banking.calls.some((c) => c.startsWith('listTransactions'))).toBe(true);
      const row = await conn(connectionId);
      expect(row.nextSyncAt!.getTime()).toBeGreaterThan(now.getTime());
      expect((await findDueConnections(t.db, now)).map((d) => d.connectionId)).not.toContain(
        connectionId,
      );
    });

    it('marks runs left running by a dead worker as abandoned when the next run starts', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      const [stale] = await t.owner
        .insert(syncRun)
        .values({
          householdId: ctx.householdId,
          connectionId,
          trigger: 'scheduled',
          status: 'running',
          startedAt: new Date(now.getTime() - 60 * MIN),
        })
        .returning();
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'manual',
      });
      const all = await runs(connectionId);
      const old = all.find((r) => r.id === stale!.id)!;
      expect(old).toMatchObject({ status: 'failed', errorCode: 'abandoned' });
      expect(old.finishedAt).not.toBeNull();
      expect(all.filter((r) => r.status === 'running')).toEqual([]);
    });
  });

  describe('Trading 212', () => {
    const position: ProviderPosition = {
      ticker: 'VWCE',
      name: 'Global ETF',
      isin: 'XX0000000001',
      instrumentCurrency: 'EUR',
      quantity: '2.5',
      averagePrice: '90',
      currentPrice: '100',
      currency: 'EUR',
      value: 25_000,
      cost: 22_500,
      unrealizedProfitLoss: 2_500,
    };

    it('syncs history, dividends, balances and positions using the decrypted credentials', async () => {
      const { ctx, t212, deps, connectionId } = await broker({ positions: [position] });
      t212.history = {
        items: [tx({ externalId: 'tx:1', amount: 100_000, description: 'DEPOSIT 1' })],
        incomplete: false,
      };
      t212.dividends = {
        items: [tx({ externalId: 'div:1', amount: 340, description: 'Dividend VWCE' })],
        incomplete: false,
      };

      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'initial',
      });

      expect(result).toMatchObject({ status: 'success', inserted: 2, providerCalls: 4 });
      expect(deps.credentialsSeen.at(-1)).toEqual({
        apiKey: 'plain-key',
        apiSecret: 'plain-secret',
      });
      expect(t212.since.every((s) => s === '2026-07-21')).toBe(true);
      const [link] = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      const balances = await t.owner
        .select()
        .from(balanceSnapshot)
        .where(eq(balanceSnapshot.accountId, link!.accountId));
      expect(balances.map((b) => [b.source, b.asOf, b.balance]).sort()).toEqual([
        ['trading212:cash', '2026-10-18', 50_000],
        ['trading212:investments', '2026-10-18', 100_000],
        ['trading212:total', '2026-10-18', 150_000],
      ]);
      const positions = await t.owner
        .select()
        .from(positionSnapshot)
        .where(eq(positionSnapshot.accountId, link!.accountId));
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        asOf: '2026-10-18',
        instrument: 'XX0000000001',
        name: 'Global ETF',
        valueMinor: 25_000,
        priceMinor: 10_000,
        currency: 'EUR',
        costMinor: 22_500,
        unrealizedPlMinor: 2_500,
        ticker: 'VWCE',
        isin: 'XX0000000001',
      });
      expect(Number(positions[0]!.quantity)).toBe(2.5);
      expect((await conn(connectionId)).lastSuccessAt).not.toBeNull();

      // Same day again: positions are replaced, not duplicated.
      t212.positions = [{ ...position, value: 30_000 }];
      now = new Date(now.getTime() + 10 * MIN);
      await makeDue(connectionId);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      const again = await t.owner
        .select()
        .from(positionSnapshot)
        .where(eq(positionSnapshot.accountId, link!.accountId));
      expect(again.map((p) => p.valueMinor)).toEqual([30_000]);
    });

    describe('pies', () => {
      async function linkAccountId(connectionId: string) {
        const [link] = await t.owner
          .select()
          .from(connectionAccount)
          .where(eq(connectionAccount.connectionId, connectionId));
        return link!.accountId;
      }
      const run = (
        deps: Parameters<typeof syncConnection>[0],
        ctx: { householdId: string },
        connectionId: string,
      ) => syncConnection(deps, { householdId: ctx.householdId, connectionId, trigger: 'manual' });

      it('stores buckets and one snapshot per pie, naming only new pies on a repeat run', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [
          { id: '101', invested: 40_000, value: 45_000 },
          { id: '102', invested: 10_000, value: 9_000 },
        ];
        t212.pieNames = { '101': 'Reforma', '102': 'Férias' };
        expect(await run(deps, ctx, connectionId)).toMatchObject({ status: 'success' });
        const accountId = await linkAccountId(connectionId);
        const buckets = await t.owner
          .select()
          .from(investmentBucket)
          .where(eq(investmentBucket.accountId, accountId));
        expect(buckets.map((b) => [b.externalId, b.name, b.provider, b.removedAt]).sort()).toEqual([
          ['101', 'Reforma', 'trading212', null],
          ['102', 'Férias', 'trading212', null],
        ]);
        const snaps = await t.owner
          .select()
          .from(investmentBucketSnapshot)
          .where(eq(investmentBucketSnapshot.accountId, accountId));
        expect(
          snaps.map((s) => [s.asOf, s.investedMinor, s.valueMinor, s.currency]).sort(),
        ).toEqual([
          ['2026-10-18', 10_000, 9_000, 'EUR'],
          ['2026-10-18', 40_000, 45_000, 'EUR'],
        ]);
        expect(t212.calls.filter((c) => c.startsWith('getPieName'))).toHaveLength(2);

        // Same day again: the names are known, so none is fetched, and snapshots are replaced.
        t212.calls.length = 0;
        t212.pies = [
          { id: '101', invested: 41_000, value: 46_000 },
          { id: '102', invested: 10_000, value: 9_000 },
        ];
        now = new Date(now.getTime() + 10 * MIN);
        await makeDue(connectionId);
        await run(deps, ctx, connectionId);
        expect(t212.calls.some((c) => c.startsWith('getPieName'))).toBe(false);
        const again = await t.owner
          .select()
          .from(investmentBucketSnapshot)
          .where(eq(investmentBucketSnapshot.accountId, accountId));
        expect(again.map((s) => s.investedMinor).sort()).toEqual([10_000, 41_000]);
      });

      it('marks a vanished pie removed and keeps no snapshot for it', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [
          { id: '101', invested: 40_000, value: 45_000 },
          { id: '102', invested: 10_000, value: 9_000 },
        ];
        await run(deps, ctx, connectionId);
        t212.pies = [{ id: '101', invested: 40_000, value: 45_000 }];
        now = new Date(now.getTime() + 10 * MIN);
        await makeDue(connectionId);
        await run(deps, ctx, connectionId);
        const accountId = await linkAccountId(connectionId);
        const buckets = await t.owner
          .select()
          .from(investmentBucket)
          .where(eq(investmentBucket.accountId, accountId));
        const byExt = new Map(buckets.map((b) => [b.externalId, b]));
        expect(byExt.get('101')!.removedAt).toBeNull();
        expect(byExt.get('102')!.removedAt).not.toBeNull();
        const snaps = await t.owner
          .select()
          .from(investmentBucketSnapshot)
          .where(eq(investmentBucketSnapshot.accountId, accountId));
        expect(snaps.map((s) => s.bucketId)).toEqual([byExt.get('101')!.id]);
      });

      it('marks every pie removed when the list becomes empty and keeps the original removal time', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [{ id: '101', invested: 40_000, value: 45_000 }];
        await run(deps, ctx, connectionId);
        const accountId = await linkAccountId(connectionId);
        const bucketRows = () =>
          t.owner.select().from(investmentBucket).where(eq(investmentBucket.accountId, accountId));
        t212.pies = [];
        now = new Date(now.getTime() + DAY);
        await makeDue(connectionId);
        expect(await run(deps, ctx, connectionId)).toMatchObject({ status: 'success' });
        const [removed] = await bucketRows();
        expect(removed!.removedAt).not.toBeNull();
        expect(
          await t.owner
            .select()
            .from(investmentBucketSnapshot)
            .where(
              and(
                eq(investmentBucketSnapshot.accountId, accountId),
                eq(investmentBucketSnapshot.asOf, '2026-10-19'),
              ),
            ),
        ).toHaveLength(0);

        now = new Date(now.getTime() + DAY);
        await makeDue(connectionId);
        await run(deps, ctx, connectionId);
        const [third] = await bucketRows();
        expect(third!.removedAt).toEqual(removed!.removedAt);
      });

      it('keeps every pie snapshot when one name lookup fails with a response error', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [
          { id: '101', invested: 40_000, value: 45_000 },
          { id: '102', invested: 10_000, value: 9_000 },
        ];
        t212.pieNames = { '101': 'Reforma' };
        const getPieName = t212.getPieName.bind(t212);
        t212.getPieName = async (id) => {
          if (id === '102') throw new ProviderResponseError('Unexpected response: pie name');
          return getPieName(id);
        };
        expect(await run(deps, ctx, connectionId)).toMatchObject({ status: 'success' });
        const accountId = await linkAccountId(connectionId);
        const buckets = await t.owner
          .select()
          .from(investmentBucket)
          .where(eq(investmentBucket.accountId, accountId));
        // The failed pie falls back to its id; the other pie keeps its real name.
        expect(buckets.map((b) => [b.externalId, b.name]).sort()).toEqual([
          ['101', 'Reforma'],
          ['102', '102'],
        ]);
        expect(
          await t.owner
            .select()
            .from(investmentBucketSnapshot)
            .where(eq(investmentBucketSnapshot.accountId, accountId)),
        ).toHaveLength(2);
      });

      it('keeps the stored name of a pie whose name lookup fails on a later day', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [{ id: '101', invested: 40_000, value: 45_000 }];
        t212.pieNames = { '101': 'Reforma' };
        await run(deps, ctx, connectionId);
        t212.getPieName = async () => {
          throw new ProviderResponseError('Unexpected response: pie name');
        };
        now = new Date(now.getTime() + DAY);
        await makeDue(connectionId);
        await run(deps, ctx, connectionId);
        const accountId = await linkAccountId(connectionId);
        const [bucket] = await t.owner
          .select()
          .from(investmentBucket)
          .where(eq(investmentBucket.accountId, accountId));
        expect(bucket!.name).toBe('Reforma');
        expect(
          await t.owner
            .select()
            .from(investmentBucketSnapshot)
            .where(
              and(
                eq(investmentBucketSnapshot.accountId, accountId),
                eq(investmentBucketSnapshot.asOf, '2026-10-19'),
              ),
            ),
        ).toHaveLength(1);
      });

      it('refetches every pie name on a new day and renames a bucket', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [{ id: '101', invested: 40_000, value: 45_000 }];
        t212.pieNames = { '101': 'Reforma' };
        await run(deps, ctx, connectionId);
        t212.calls.length = 0;
        t212.pieNames = { '101': 'Reforma 2' };
        now = new Date(now.getTime() + DAY);
        await makeDue(connectionId);
        await run(deps, ctx, connectionId);
        expect(t212.calls.filter((c) => c.startsWith('getPieName'))).toEqual(['getPieName:101']);
        const accountId = await linkAccountId(connectionId);
        const [bucket] = await t.owner
          .select()
          .from(investmentBucket)
          .where(eq(investmentBucket.accountId, accountId));
        expect(bucket!.name).toBe('Reforma 2');
      });

      it('writes nothing for pies when a name lookup fails half way with an auth error', async () => {
        const { ctx, t212, deps, connectionId } = await broker();
        t212.pies = [
          { id: '101', invested: 40_000, value: 45_000 },
          { id: '102', invested: 10_000, value: 9_000 },
        ];
        const getPieName = t212.getPieName.bind(t212);
        t212.getPieName = async (id) => {
          if (id === '102') throw new ProviderAuthError();
          return getPieName(id);
        };
        expect(await run(deps, ctx, connectionId)).toMatchObject({ status: 'success' });
        const accountId = await linkAccountId(connectionId);
        expect(
          await t.owner
            .select()
            .from(investmentBucket)
            .where(eq(investmentBucket.accountId, accountId)),
        ).toHaveLength(0);
        expect(
          await t.owner
            .select()
            .from(investmentBucketSnapshot)
            .where(eq(investmentBucketSnapshot.accountId, accountId)),
        ).toHaveLength(0);
      });

      it('keeps the sync successful and the rest saved when pies are not permitted', async () => {
        const { ctx, t212, deps, connectionId } = await broker({ positions: [position] });
        t212.failPies = new ProviderAuthError();
        const result = await run(deps, ctx, connectionId);
        expect(result).toMatchObject({ status: 'success' });
        const accountId = await linkAccountId(connectionId);
        expect(
          await t.owner
            .select()
            .from(balanceSnapshot)
            .where(eq(balanceSnapshot.accountId, accountId)),
        ).toHaveLength(3);
        expect(
          await t.owner
            .select()
            .from(positionSnapshot)
            .where(eq(positionSnapshot.accountId, accountId)),
        ).toHaveLength(1);
        expect((await conn(connectionId)).status).toBe('active');
        expect(t212.calls).toContain('listPies');
        expect(
          await t.owner
            .select()
            .from(investmentBucket)
            .where(eq(investmentBucket.accountId, accountId)),
        ).toHaveLength(0);
      });
    });

    it('treats credentials the provider rejects as an expired connection', async () => {
      const { ctx, t212, deps, connectionId } = await broker();
      t212.failSummary = new ProviderAuthError();
      expect(
        await syncConnection(deps, {
          householdId: ctx.householdId,
          connectionId,
          trigger: 'scheduled',
        }),
      ).toMatchObject({ status: 'failed', errorCode: 'auth' });
      expect((await conn(connectionId)).status).toBe('expired');
      expect((await notifications(ctx)).map((n) => n.dedupeKey)).toEqual([
        `consent-expired:${connectionId}:2026-10-18`,
      ]);
    });

    it('books Trading 212 rows on the household local day, not the UTC one', async () => {
      const { ctx, t212, deps, connectionId } = await broker();
      await t.owner
        .update(schema.householdSettings)
        .set({ timezone: 'Europe/Lisbon' })
        .where(eq(schema.householdSettings.householdId, ctx.householdId));
      const late = {
        bookingDate: '2026-10-17',
        valueDate: '2026-10-17',
        transactionDate: '2026-10-17',
        occurredAt: '2026-10-17T23:30:00.000Z',
      };
      t212.history = {
        items: [
          tx({ externalId: 'tx:late', ...late }),
          tx({ externalId: 'tx:dateonly', description: 'No time', bookingDate: '2026-10-17' }),
        ],
        incomplete: false,
      };
      t212.dividends = {
        items: [tx({ externalId: 'div:late', description: 'Dividend X', ...late })],
        incomplete: false,
      };
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'initial',
      });
      const rows = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.householdId, ctx.householdId));
      const by = (id: string) => rows.find((r) => r.externalId === id)!;
      for (const id of ['tx:late', 'div:late']) {
        expect(by(id)).toMatchObject({
          bookingDate: '2026-10-18',
          valueDate: '2026-10-18',
          transactionDate: '2026-10-18',
        });
      }
      expect(by('tx:dateonly').bookingDate).toBe('2026-10-17');
    });

    it('a truncated history is a partial run: ingested, but last_success_at stays unset', async () => {
      const { ctx, t212, deps, connectionId } = await broker();
      t212.history = { items: [tx({ externalId: 'tx:9' })], incomplete: true };
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(result).toMatchObject({
        status: 'partial',
        inserted: 1,
        errorCode: 'history_incomplete',
      });
      const row = await conn(connectionId);
      expect(row.lastSuccessAt).toBeNull();
      expect(row.consecutiveFailures).toBe(0);
      // Surfaced on the connection without counting as a failure; a complete run clears it.
      expect(row).toMatchObject({ lastErrorCode: 'history_incomplete', status: 'active' });
      expect(row.lastErrorMessage).toEqual(expect.any(String));
      t212.history = { items: [tx({ externalId: 'tx:9' })], incomplete: false };
      await makeDue(connectionId);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(await conn(connectionId)).toMatchObject({
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    });
  });

  describe('locking and scheduling guards', () => {
    it('skips when another run holds the connection lock, creating no run', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      const holder = await t.owner.$client.connect();
      try {
        await holder.query('select pg_advisory_lock(hashtextextended($1, 0))', [
          syncLockKey(connectionId),
        ]);
        const result = await syncConnection(deps, {
          householdId: ctx.householdId,
          connectionId,
          trigger: 'scheduled',
        });
        expect(result).toEqual({ status: 'skipped', reason: 'locked' });
        expect(await runs(connectionId)).toEqual([]);
      } finally {
        await holder.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          syncLockKey(connectionId),
        ]);
        holder.release();
      }
      const after = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(after.status).toBe('success');
    });

    it('refuses to remove a connection while a sync holds its lock', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      const holder = await t.owner.$client.connect();
      try {
        await holder.query('select pg_advisory_lock(hashtextextended($1, 0))', [
          syncLockKey(connectionId),
        ]);
        await expect(removeConnection(ctx, deps, connectionId)).rejects.toMatchObject({
          name: 'ConflictError',
          code: 'sync_in_progress',
        });
        expect(await conn(connectionId)).toBeDefined();
      } finally {
        await holder.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          syncLockKey(connectionId),
        ]);
        holder.release();
      }
      await removeConnection(ctx, deps, connectionId);
      expect(
        await t.owner.select().from(connection).where(eq(connection.id, connectionId)),
      ).toEqual([]);
    });

    it('never overlaps two concurrent runs of one connection', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const original = banking.listTransactions;
      banking.listTransactions = async (...args) => {
        entered();
        await gate;
        return original(...args);
      };
      const input = { householdId: ctx.householdId, connectionId, trigger: 'scheduled' as const };
      const first = syncConnection(deps, input);
      await inside;
      const second = await syncConnection(deps, input);
      release();
      expect(second).toEqual({ status: 'skipped', reason: 'locked' });
      expect((await first).status).toBe('success');
      expect(await runs(connectionId)).toHaveLength(1);
    });

    it('does not run a scheduled sync before next_sync_at', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      await t.owner
        .update(connection)
        .set({ nextSyncAt: new Date(now.getTime() + 60 * MIN) })
        .where(eq(connection.id, connectionId));
      const input = { householdId: ctx.householdId, connectionId, trigger: 'scheduled' as const };
      expect(await syncConnection(deps, input)).toEqual({ status: 'skipped', reason: 'not_due' });
      // A job queued twice for a first sync is not a second first sync.
      expect(await syncConnection(deps, { ...input, trigger: 'initial' })).toEqual({
        status: 'skipped',
        reason: 'not_due',
      });
      expect(banking.calls.filter((c) => c.startsWith('listTransactions'))).toEqual([]);
      expect((await syncConnection(deps, { ...input, trigger: 'manual' })).status).toBe('success');
    });

    it('skips pending connections and rejects ids of another household', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      await t.owner
        .update(connection)
        .set({ status: 'pending' })
        .where(eq(connection.id, connectionId));
      expect(
        await syncConnection(deps, {
          householdId: ctx.householdId,
          connectionId,
          trigger: 'manual',
        }),
      ).toEqual({
        status: 'skipped',
        reason: 'inactive',
      });
      const other = await t.household();
      await expect(
        syncConnection(deps, { householdId: other.householdId, connectionId, trigger: 'manual' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('manual refresh', () => {
    it('allows 2 per connection per rolling day for Enable Banking, then reports when to retry', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      const startedAt = now;
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
      now = new Date(now.getTime() + 3 * 60 * MIN);
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
      const callsBefore = banking.calls.length;

      now = new Date(now.getTime() + 60 * MIN);
      const error = await requestManualSync(ctx, deps, connectionId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ManualRefreshLimitError);
      expect((error as ManualRefreshLimitError).retryAt.toISOString()).toBe(
        new Date(startedAt.getTime() + DAY).toISOString(),
      );
      expect(banking.calls.length).toBe(callsBefore);
      expect(await runs(connectionId)).toHaveLength(2);

      // Scheduled runs do not use the manual allowance, and the oldest manual run ages out.
      await makeDue(connectionId);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      now = new Date(startedAt.getTime() + DAY + MIN);
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
    });

    it('reports the remaining allowance in listConnections with the same rule', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      const allowance = async () =>
        (await listConnections(ctx, { now })).find((c) => c.id === connectionId)!.manualRefresh;
      expect(await allowance()).toEqual({ limit: 2, remaining: 2, retryAt: null, window: 'day' });

      const startedAt = now;
      await requestManualSync(ctx, deps, connectionId);
      expect(await allowance()).toEqual({ limit: 2, remaining: 1, retryAt: null, window: 'day' });

      now = new Date(now.getTime() + 3 * 60 * MIN);
      await requestManualSync(ctx, deps, connectionId);
      expect(await allowance()).toEqual({
        limit: 2,
        remaining: 0,
        retryAt: new Date(startedAt.getTime() + DAY).toISOString(),
        window: 'day',
      });

      // The oldest manual run ages out of the rolling day.
      now = new Date(startedAt.getTime() + DAY + MIN);
      expect(await allowance()).toEqual({ limit: 2, remaining: 1, retryAt: null, window: 'day' });
    });

    it('reports one per 5 minutes for Trading 212', async () => {
      const { ctx, deps, connectionId } = await broker();
      const allowance = async () =>
        (await listConnections(ctx, { now })).find((c) => c.id === connectionId)!.manualRefresh;
      expect(await allowance()).toEqual({ limit: 1, remaining: 1, retryAt: null, window: '5min' });
      const startedAt = now;
      await requestManualSync(ctx, deps, connectionId);
      expect(await allowance()).toEqual({
        limit: 1,
        remaining: 0,
        retryAt: new Date(startedAt.getTime() + 5 * MIN).toISOString(),
        window: '5min',
      });
    });

    it('allows one per 5 minutes for Trading 212', async () => {
      const { ctx, deps, connectionId } = await broker();
      const startedAt = now;
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
      now = new Date(now.getTime() + 2 * MIN);
      const error = await requestManualSync(ctx, deps, connectionId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ManualRefreshLimitError);
      expect((error as ManualRefreshLimitError).retryAt.toISOString()).toBe(
        new Date(startedAt.getTime() + 5 * MIN).toISOString(),
      );
      now = new Date(startedAt.getTime() + 5 * MIN);
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
    });

    it('is forbidden for viewers, not found across households and refused for inactive connections', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      await expect(
        requestManualSync(withRole(ctx, 'viewer'), deps, connectionId),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const other = await t.household();
      await expect(requestManualSync(other, deps, connectionId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await t.owner
        .update(connection)
        .set({ status: 'expired' })
        .where(eq(connection.id, connectionId));
      await expect(requestManualSync(ctx, deps, connectionId)).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'connection_inactive',
      });
    });
  });

  describe('findDueConnections', () => {
    it('returns only active connections whose next_sync_at has passed, across households', async () => {
      const due = await bank(1);
      const future = await bank(1);
      const expired = await bank(1);
      const pending = await bank(1);
      const unscheduled = await bank(1);
      const brokerDue = await broker();
      const at = new Date('2026-10-18T12:00:00Z');
      const set = (id: string, patch: Partial<typeof connection.$inferInsert>) =>
        t.owner.update(connection).set(patch).where(eq(connection.id, id));
      await set(due.connectionId, { nextSyncAt: new Date(at.getTime() - MIN) });
      await set(future.connectionId, { nextSyncAt: new Date(at.getTime() + MIN) });
      await set(expired.connectionId, {
        nextSyncAt: new Date(at.getTime() - MIN),
        status: 'expired',
      });
      await set(pending.connectionId, {
        nextSyncAt: new Date(at.getTime() - MIN),
        status: 'pending',
      });
      await set(unscheduled.connectionId, { nextSyncAt: null });
      await set(brokerDue.connectionId, { nextSyncAt: new Date(at.getTime()), lastSuccessAt: at });

      const found = await findDueConnections(t.db, at);
      const mine = [due, future, expired, pending, unscheduled, brokerDue].map(
        (c) => c.connectionId,
      );
      const picked = found.filter((f) => mine.includes(f.connectionId));
      expect(picked.map((p) => p.connectionId).sort()).toEqual(
        [due.connectionId, brokerDue.connectionId].sort(),
      );
      expect(picked.find((p) => p.connectionId === due.connectionId)).toEqual({
        householdId: due.ctx.householdId,
        connectionId: due.connectionId,
        trigger: 'initial',
      });
      expect(picked.find((p) => p.connectionId === brokerDue.connectionId)?.trigger).toBe(
        'scheduled',
      );
    });
  });

  describe('PSD2 budget', () => {
    const input = (
      ctx: ServiceCtx,
      connectionId: string,
      trigger: 'scheduled' | 'manual' | 'initial',
    ) => ({ householdId: ctx.householdId, connectionId, trigger });

    it('forwards the PSU headers of a manual refresh to every bank call, and none on scheduled runs', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      const psuHeaders = { ipAddress: '203.0.113.9', userAgent: 'Browser/1.0' };
      await requestManualSync(ctx, deps, connectionId, { psuHeaders });
      expect(banking.psu).toHaveLength(4);
      for (const call of banking.psu) expect(call.headers).toEqual(psuHeaders);

      banking.psu.length = 0;
      now = new Date(now.getTime() + DAY);
      await makeDue(connectionId);
      await syncConnection(deps, input(ctx, connectionId, 'scheduled'));
      expect(banking.psu).toHaveLength(4);
      for (const call of banking.psu) expect(call.headers).toBeUndefined();
    });

    it('skips a scheduled run when a successful unattended run happened in the last 20 hours', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      expect((await syncConnection(deps, input(ctx, connectionId, 'scheduled'))).status).toBe(
        'success',
      );
      const callsAfterFirst = banking.calls.length;

      now = new Date(now.getTime() + 19 * 60 * MIN);
      await makeDue(connectionId);
      const result = await syncConnection(deps, input(ctx, connectionId, 'scheduled'));
      expect(result).toEqual({ status: 'skipped', reason: 'daily_budget' });
      expect(banking.calls).toHaveLength(callsAfterFirst);

      const all = await runs(connectionId);
      expect(all).toHaveLength(2);
      expect(all[1]).toMatchObject({
        status: 'skipped',
        trigger: 'scheduled',
        errorCode: 'daily_budget',
        providerCalls: 0,
      });
      expect(all[1]!.finishedAt).not.toBeNull();
      // The slot is spent: the connection is not due again until tomorrow's window.
      const row = await conn(connectionId);
      expect(row.nextSyncAt!.getTime()).toBeGreaterThan(now.getTime());
      expect(row.consecutiveFailures).toBe(0);
    });

    it('runs again once 20 hours have passed', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      await syncConnection(deps, input(ctx, connectionId, 'scheduled'));
      now = new Date(now.getTime() + 20 * 60 * MIN + MIN);
      await makeDue(connectionId);
      expect((await syncConnection(deps, input(ctx, connectionId, 'scheduled'))).status).toBe(
        'success',
      );
    });

    it('counts a partial run but not a failed one, and applies to initial runs too', async () => {
      const failing = await bank(1);
      failing.banking.txs['uid-1'] = () => {
        throw new ProviderUnavailableError();
      };
      expect(
        (await syncConnection(failing.deps, input(failing.ctx, failing.connectionId, 'scheduled')))
          .status,
      ).toBe('failed');
      failing.banking.txs['uid-1'] = [];
      now = new Date(now.getTime() + MIN);
      await makeDue(failing.connectionId);
      expect(
        (await syncConnection(failing.deps, input(failing.ctx, failing.connectionId, 'scheduled')))
          .status,
      ).toBe('success');

      const partial = await bank(2);
      partial.banking.txs['uid-2'] = () => {
        throw new ProviderUnavailableError();
      };
      expect(
        (await syncConnection(partial.deps, input(partial.ctx, partial.connectionId, 'scheduled')))
          .status,
      ).toBe('partial');
      now = new Date(now.getTime() + MIN);
      await makeDue(partial.connectionId);
      expect(
        await syncConnection(partial.deps, input(partial.ctx, partial.connectionId, 'initial')),
      ).toEqual({ status: 'skipped', reason: 'daily_budget' });
    });

    it('does not count manual runs, and never blocks a manual refresh', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      await requestManualSync(ctx, deps, connectionId);
      now = new Date(now.getTime() + 60 * MIN);
      await makeDue(connectionId);
      expect((await syncConnection(deps, input(ctx, connectionId, 'scheduled'))).status).toBe(
        'success',
      );
      now = new Date(now.getTime() + 60 * MIN);
      expect((await requestManualSync(ctx, deps, connectionId)).status).toBe('success');
    });

    it('does not apply to Trading 212', async () => {
      const { ctx, deps, connectionId } = await broker();
      await syncConnection(deps, input(ctx, connectionId, 'scheduled'));
      now = new Date(now.getTime() + 60 * MIN);
      await makeDue(connectionId);
      expect((await syncConnection(deps, input(ctx, connectionId, 'scheduled'))).status).toBe(
        'success',
      );
    });
  });

  describe('unmappable bank rows', () => {
    it('skips the bad rows, keeps the account syncing and reports a partial run with their count', async () => {
      const { ctx, banking, deps, connectionId, links } = await bank(1);
      banking.txs['uid-1'] = [tx({ externalId: 'ok-1' })];
      banking.skippedRows['uid-1'] = 2;
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(result).toMatchObject({ status: 'partial', inserted: 1, errorCode: 'skipped_rows' });
      expect(await txCount(links[0]!.accountId)).toBe(1);

      const [run] = await runs(connectionId);
      expect(run).toMatchObject({
        status: 'partial',
        skippedRows: 2,
        errorCode: 'skipped_rows',
      });
      // No row content is stored with the run.
      expect(run!.errorMessage).not.toMatch(/ok-1|Coffee/);
      // The data is current: this is not a failure and raises no alert.
      const row = await conn(connectionId);
      expect(row.lastSuccessAt?.toISOString()).toBe(now.toISOString());
      // The warning code stays on the connection so the UI can show it.
      expect(row).toMatchObject({
        consecutiveFailures: 0,
        lastErrorCode: 'skipped_rows',
        status: 'active',
      });
      expect(await notifications(ctx)).toEqual([]);
    });

    it('treats an account whose every row was unreadable as failed, and alerts after the threshold', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      const before = (await conn(connectionId)).lastSuccessAt;
      banking.txs['uid-1'] = [];
      banking.skippedRows['uid-1'] = 3;

      now = new Date(now.getTime() + DAY);
      await makeDue(connectionId);
      const first = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect(first.status).toBe('failed');
      expect((await runs(connectionId)).find((r) => r.status === 'failed')).toMatchObject({
        skippedRows: 3,
      });
      let row = await conn(connectionId);
      expect(row.lastSuccessAt?.toISOString()).toBe(before?.toISOString());
      expect(row).toMatchObject({ consecutiveFailures: 1, lastErrorCode: 'bad_response' });
      expect(await notifications(ctx)).toEqual([]);

      now = new Date(now.getTime() + DAY);
      await makeDue(connectionId);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      row = await conn(connectionId);
      expect(row.consecutiveFailures).toBe(2);
      expect(row.lastSuccessAt?.toISOString()).toBe(before?.toISOString());
      expect((await notifications(ctx)).map((n) => n.kind)).toEqual(['sync_failing']);
    });

    it('counts skipped rows across accounts', async () => {
      const { ctx, banking, deps, connectionId } = await bank(2);
      banking.skippedRows['uid-1'] = 1;
      banking.skippedRows['uid-2'] = 3;
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect((await runs(connectionId))[0]!.skippedRows).toBe(4);
    });

    it('a clean run records zero skipped rows', async () => {
      const { ctx, deps, connectionId } = await bank(1);
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'scheduled',
      });
      expect((await runs(connectionId))[0]).toMatchObject({ status: 'success', skippedRows: 0 });
    });
  });

  describe('window and consent races', () => {
    it('never asks the provider for more than 89 days, however old last_success_at is', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      await t.owner
        .update(connection)
        .set({ lastSuccessAt: new Date(now.getTime() - 120 * DAY) })
        .where(eq(connection.id, connectionId));
      await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'manual',
      });
      expect(banking.txRanges[0]).toMatchObject({ dateFrom: '2026-07-21', dateTo: '2026-10-18' });
    });

    it('leaves the connection active when it was renewed while the failing run was in flight', async () => {
      const { ctx, banking, deps, connectionId } = await bank(1);
      banking.beforeTransactions = async () => {
        // A renewal lands (new session secret) just before the old session is reported expired.
        await t.owner
          .update(connection)
          .set({ externalSessionIdEnc: 'renewed-session-token' })
          .where(eq(connection.id, connectionId));
      };
      banking.txs['uid-1'] = () => {
        throw new ProviderAuthError();
      };
      const result = await syncConnection(deps, {
        householdId: ctx.householdId,
        connectionId,
        trigger: 'manual',
      });
      expect(result).toMatchObject({ status: 'failed', errorCode: 'auth' });
      expect((await conn(connectionId)).status).toBe('active');
      expect(await notifications(ctx)).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('keeps rows of two households apart', async () => {
      const x = await bank(1);
      const y = await bank(1);
      x.banking.txs['uid-1'] = [tx({ externalId: 'iso-1' })];
      await syncConnection(x.deps, {
        householdId: x.ctx.householdId,
        connectionId: x.connectionId,
        trigger: 'manual',
      });
      const seenByY = await t.owner
        .select()
        .from(transaction)
        .where(and(eq(transaction.householdId, y.ctx.householdId)));
      expect(seenByY).toEqual([]);
      expect(await notifications(y.ctx)).toEqual([]);
    });
  });
});
