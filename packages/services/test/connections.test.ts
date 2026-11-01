import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
} from '@arfolio/connectors';
import { decryptSecret } from '@arfolio/core/server';
import { schema } from '@arfolio/db';
import {
  addTrading212Connection,
  BankingNotConfiguredError,
  completeBankConsent,
  ConflictError,
  ConsentStateError,
  createAccount,
  ForbiddenError,
  linkConnectionAccounts,
  listBanks,
  listConnectionAccounts,
  listConnections,
  NotFoundError,
  removeConnection,
  startBankConsent,
  updateTrading212Credentials,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { syncLockKey } from '../src/internal.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  fakeBanking,
  fakeTrading212,
  makeDeps,
  TEST_KEY,
} from './connector-fakes.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { connection, connectionAccount, consentState, financialAccount, transaction } = schema;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('connection lifecycle', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
  });
  afterAll(() => t.close());

  /** Simulates a connection created before the accounts cache existed. */
  async function dropAccountsCache(connectionId: string): Promise<void> {
    await t.owner
      .update(connection)
      .set({ externalAccountsEnc: null })
      .where(eq(connection.id, connectionId));
  }

  /** Holds the connection's sync lock like a running sync would; call the result to release. */
  async function holdSyncLock(connectionId: string): Promise<() => Promise<void>> {
    const holder = await t.owner.$client.connect();
    await holder.query('select pg_advisory_lock(hashtextextended($1, 0))', [
      syncLockKey(connectionId),
    ]);
    return async () => {
      await holder.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
        syncLockKey(connectionId),
      ]);
      holder.release();
    };
  }

  async function consent(ctx: ServiceCtx, banking = fakeBanking(), connectionId?: string) {
    const deps = makeDeps(banking, undefined);
    const started = await startBankConsent(ctx, deps, {
      aspspName: 'Test Bank',
      country: 'PT',
      ...(connectionId ? { connectionId } : {}),
    });
    const state = banking.states.at(-1)!;
    return { deps, banking, started, state };
  }

  describe('startBankConsent', () => {
    it('stores only the sha256 of a 32-byte base64url state, valid for 30 minutes', async () => {
      const { started, state } = await consent(a);
      expect(started.redirectUrl).toMatch(/^https:\/\/bank\.example\//);
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await t.owner
        .select()
        .from(consentState)
        .where(eq(consentState.stateHash, sha256(state)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        householdId: a.householdId,
        userId: a.userId,
        aspspName: 'Test Bank',
        aspspCountry: 'PT',
        usedAt: null,
      });
      const ttl = rows[0]!.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000);
      const all = await t.owner.select().from(consentState);
      expect(JSON.stringify(all)).not.toContain(state);
    });

    it('is forbidden for viewers and rejects unknown banks', async () => {
      const deps = makeDeps(fakeBanking(), undefined);
      await expect(
        startBankConsent(withRole(a, 'viewer'), deps, { aspspName: 'Test Bank', country: 'PT' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        startBankConsent(a, deps, { aspspName: 'Nope', country: 'PT' }),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'unknown_bank' });
    });

    it('reports a typed error when Enable Banking is not configured', async () => {
      await expect(
        startBankConsent(a, makeDeps(undefined, undefined), {
          aspspName: 'Test Bank',
          country: 'PT',
        }),
      ).rejects.toBeInstanceOf(BankingNotConfiguredError);
    });

    it('refuses to reconnect a connection of another household', async () => {
      const { deps, state } = await consent(b);
      const done = await completeBankConsent(b, deps, { state, code: 'c' });
      await expect(
        startBankConsent(a, deps, {
          aspspName: 'Test Bank',
          country: 'PT',
          connectionId: done.connectionId,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('completeBankConsent', () => {
    it('creates a pending connection with an encrypted session id and the provider expiry', async () => {
      const { deps, state, banking } = await consent(a);
      const result = await completeBankConsent(a, deps, { state, code: 'auth-code' });
      expect(result.externalAccounts.map((x) => x.externalKey)).toEqual(['key-a', 'key-b']);
      const [row] = await t.owner
        .select()
        .from(connection)
        .where(eq(connection.id, result.connectionId));
      expect(row).toMatchObject({
        householdId: a.householdId,
        provider: 'enablebanking',
        status: 'pending',
        institutionName: 'Test Bank',
        institutionCountry: 'PT',
        createdBy: a.userId,
        credentialsEnc: null,
      });
      expect(row!.consentExpiresAt?.toISOString()).toBe('2027-01-15T00:00:00.000Z');
      expect(row!.externalSessionIdEnc).not.toContain('session-');
      expect(
        decryptSecret(
          row!.externalSessionIdEnc!,
          TEST_KEY,
          `connection:${row!.id}:external_session_id`,
        ),
      ).toBe('session-1-secret');
      expect(banking.calls.filter((c) => c === 'createSession')).toHaveLength(1);
    });

    it('marks the state used so a replay fails', async () => {
      const { deps, state } = await consent(a);
      await completeBankConsent(a, deps, { state, code: 'c' });
      await expect(completeBankConsent(a, deps, { state, code: 'c' })).rejects.toMatchObject({
        name: 'ConsentStateError',
        reason: 'used',
      });
    });

    it('does not let two concurrent completions both use one state', async () => {
      const { deps, state, banking } = await consent(a);
      const results = await Promise.allSettled([
        completeBankConsent(a, deps, { state, code: 'c' }),
        completeBankConsent(a, deps, { state, code: 'c' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(banking.calls.filter((c) => c === 'createSession')).toHaveLength(1);
    });

    it('rejects an expired state', async () => {
      const banking = fakeBanking();
      const deps = makeDeps(banking, undefined);
      await startBankConsent(a, deps, { aspspName: 'Test Bank', country: 'PT' });
      const later = makeDeps(banking, undefined, () => new Date(Date.now() + 31 * 60_000));
      await expect(
        completeBankConsent(a, later, { state: banking.states[0]!, code: 'c' }),
      ).rejects.toMatchObject({ name: 'ConsentStateError', reason: 'expired' });
    });

    it('rejects a state started by another user of the household', async () => {
      const { deps, state } = await consent(a);
      const other = { ...a, userId: 'user-2' };
      await expect(completeBankConsent(other, deps, { state, code: 'c' })).rejects.toMatchObject({
        reason: 'user_mismatch',
      });
      // The failed attempt did not burn the state for its rightful owner.
      await expect(completeBankConsent(a, deps, { state, code: 'c' })).resolves.toBeDefined();
    });

    it('rejects a state from another household or an unknown one', async () => {
      const { deps, state } = await consent(a);
      await expect(completeBankConsent(b, deps, { state, code: 'c' })).rejects.toMatchObject({
        reason: 'unknown',
      });
      await expect(
        completeBankConsent(a, deps, { state: 'nope', code: 'c' }),
      ).rejects.toBeInstanceOf(ConsentStateError);
    });

    it('renews an existing connection: new session, old one revoked, accounts relinked by stable key', async () => {
      const first = await consent(a);
      const { connectionId } = await completeBankConsent(a, first.deps, {
        state: first.state,
        code: 'c',
      });
      const acc = await createAccount(a, { name: 'Current', type: 'checking' });
      await linkConnectionAccounts(a, first.deps, connectionId, [
        { externalKey: 'key-a', accountId: acc.id },
      ]);

      const banking = fakeBanking(1);
      banking.sessionAccounts = [
        { ...ACCOUNT_A, externalUid: 'uid-a-2' },
        { ...ACCOUNT_B, externalUid: 'uid-b-2' },
      ];
      banking.validUntil = '2027-04-01T00:00:00.000Z';
      const second = await consent(a, banking, connectionId);
      const renewed = await completeBankConsent(a, second.deps, {
        state: second.state,
        code: 'c2',
      });

      expect(renewed.connectionId).toBe(connectionId);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row).toMatchObject({ status: 'active', consecutiveFailures: 0 });
      expect(row!.consentExpiresAt?.toISOString()).toBe('2027-04-01T00:00:00.000Z');
      expect(
        decryptSecret(
          row!.externalSessionIdEnc!,
          TEST_KEY,
          `connection:${connectionId}:external_session_id`,
        ),
      ).toBe('session-2-secret');
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        externalKey: 'key-a',
        externalUid: 'uid-a-2',
        accountId: acc.id,
      });
      expect(banking.deletedSessions).toEqual(['session-1-secret']);
    });

    it('replaces the cached accounts on renewal', async () => {
      const first = await consent(a);
      const { connectionId } = await completeBankConsent(a, first.deps, {
        state: first.state,
        code: 'c',
      });
      const banking = fakeBanking(1);
      banking.sessionAccounts = [{ ...ACCOUNT_B, externalUid: 'uid-b-2' }];
      const second = await consent(a, banking, connectionId);
      await completeBankConsent(a, second.deps, { state: second.state, code: 'c2' });
      banking.calls.length = 0;
      const listed = await listConnectionAccounts(a, second.deps, connectionId);
      expect(listed.map((x) => x.externalKey)).toEqual(['key-b']);
      expect(banking.calls).toEqual([]);
    });

    it('is refused while a sync holds the connection lock, without using the consent state or the code', async () => {
      const first = await consent(a);
      const { connectionId } = await completeBankConsent(a, first.deps, {
        state: first.state,
        code: 'c',
      });
      const banking = fakeBanking(1);
      const second = await consent(a, banking, connectionId);
      const release = await holdSyncLock(connectionId);
      try {
        await expect(
          completeBankConsent(a, second.deps, { state: second.state, code: 'c2' }),
        ).rejects.toMatchObject({ name: 'ConflictError', code: 'sync_in_progress' });
        expect(banking.calls).not.toContain('createSession');
      } finally {
        await release();
      }
      // The state is still usable once the sync is done.
      await expect(
        completeBankConsent(a, second.deps, { state: second.state, code: 'c2' }),
      ).resolves.toMatchObject({ connectionId });
    });

    it('revokes the new session when it cannot be stored, then rethrows', async () => {
      const banking = fakeBanking();
      const { state } = await consent(a, banking);
      // A key of the wrong size makes the encrypt-and-store step throw after the code exchange.
      const broken = { ...makeDeps(banking, undefined), encryptionKey: Buffer.alloc(5) };
      await expect(completeBankConsent(a, broken, { state, code: 'c' })).rejects.toThrow(
        'Encryption key must be 32 bytes',
      );
      expect(banking.calls.filter((c) => c === 'createSession')).toHaveLength(1);
      expect(banking.deletedSessions).toEqual(['session-1-secret']);
    });

    it('still rethrows the storage error when revoking the new session also fails', async () => {
      const banking = fakeBanking();
      banking.failDeleteSession = true;
      const { state } = await consent(a, banking);
      const broken = { ...makeDeps(banking, undefined), encryptionKey: Buffer.alloc(5) };
      await expect(completeBankConsent(a, broken, { state, code: 'c' })).rejects.toThrow(
        'Encryption key must be 32 bytes',
      );
      expect(banking.deletedSessions).toEqual(['session-1-secret']);
    });

    it('never relinks an account whose key is only the session uid; it is unlinked for the user to relink', async () => {
      const unstableFirst = fakeBanking();
      unstableFirst.sessionAccounts = [
        {
          externalUid: 'volatile-1',
          externalKey: 'volatile-1',
          name: 'Odd',
          currency: 'EUR',
          stableKey: false,
        },
      ];
      const c1 = await consent(a, unstableFirst);
      const { connectionId } = await completeBankConsent(a, c1.deps, {
        state: c1.state,
        code: 'c',
      });
      const acc = await createAccount(a, { name: 'Odd', type: 'checking' });
      await linkConnectionAccounts(a, c1.deps, connectionId, [
        { externalKey: 'volatile-1', accountId: acc.id },
      ]);

      const unstableSecond = fakeBanking();
      unstableSecond.sessionAccounts = [
        {
          externalUid: 'volatile-2',
          externalKey: 'volatile-2',
          name: 'Odd',
          currency: 'EUR',
          stableKey: false,
        },
      ];
      const c2 = await consent(a, unstableSecond, connectionId);
      const renewed = await completeBankConsent(a, c2.deps, { state: c2.state, code: 'c' });

      expect(renewed.externalAccounts.map((x) => x.externalKey)).toEqual(['volatile-2']);
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links).toEqual([]);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row!.status).toBe('pending');
      const [account] = await t.owner
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.id, acc.id));
      expect(account!.connectionId).toBeNull();
    });
  });

  describe('linkConnectionAccounts', () => {
    async function pending(ctx: ServiceCtx) {
      const c = await consent(ctx);
      const { connectionId } = await completeBankConsent(ctx, c.deps, {
        state: c.state,
        code: 'c',
      });
      return { ...c, connectionId };
    }

    it('links an existing account and creates another, then activates the connection', async () => {
      const { deps, connectionId } = await pending(a);
      const existing = await createAccount(a, { name: 'Mine', type: 'checking' });
      const result = await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', accountId: existing.id },
        { externalKey: 'key-b', create: { name: 'Bank savings', type: 'savings' } },
      ]);
      expect(result.linked).toHaveLength(2);
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links.map((l) => [l.externalKey, l.externalUid, l.currency]).sort()).toEqual([
        ['key-a', 'uid-a-1', 'EUR'],
        ['key-b', 'uid-b-1', 'EUR'],
      ]);
      const created = links.find((l) => l.externalKey === 'key-b')!;
      const [acc] = await t.owner
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.id, created.accountId));
      expect(acc).toMatchObject({
        name: 'Bank savings',
        type: 'savings',
        currency: 'EUR',
        connectionId,
        institutionName: 'Test Bank',
      });
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row!.status).toBe('active');
      expect(row!.nextSyncAt).not.toBeNull();
    });

    it('reports an invalid provider currency as a ValidationError', async () => {
      const banking = fakeBanking();
      banking.sessionAccounts = [{ ...ACCOUNT_A, currency: 'eur' }];
      const c = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, c.deps, { state: c.state, code: 'c' });
      await expect(
        linkConnectionAccounts(a, c.deps, connectionId, [
          { externalKey: 'key-a', create: { name: 'x', type: 'cash' } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'currency_mismatch' });
    });

    it('rejects a currency mismatch, a double link, bad input, viewers and other households', async () => {
      const { deps, connectionId } = await pending(a);
      const usd = await createAccount(a, { name: 'Dollars', type: 'checking', currency: 'USD' });
      await expect(
        linkConnectionAccounts(a, deps, connectionId, [
          { externalKey: 'key-a', accountId: usd.id },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'currency_mismatch' });
      await expect(
        linkConnectionAccounts(a, deps, connectionId, [
          { externalKey: 'missing', create: { name: 'x', type: 'cash' } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'unknown_provider_account' });
      await expect(
        linkConnectionAccounts(a, deps, connectionId, [
          { externalKey: 'key-a', accountId: usd.id, create: { name: 'x', type: 'cash' } },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);

      const eur = await createAccount(a, { name: 'Euros', type: 'checking' });
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', accountId: eur.id },
      ]);
      const other = await pending(a);
      await expect(
        linkConnectionAccounts(a, other.deps, other.connectionId, [
          { externalKey: 'key-b', accountId: eur.id },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'account_linked_elsewhere' });

      await expect(
        linkConnectionAccounts(withRole(a, 'viewer'), deps, connectionId, []),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(linkConnectionAccounts(b, deps, connectionId, [])).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('relinking an account to another external account on the same connection replaces the link', async () => {
      const { deps, connectionId } = await pending(a);
      const acc = await createAccount(a, { name: 'Re', type: 'checking' });
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', accountId: acc.id },
      ]);
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-b', accountId: acc.id },
      ]);
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links.map((l) => l.externalKey)).toEqual(['key-b']);
    });

    it('stops syncing a linked account: link removed, account and transactions kept', async () => {
      const { deps, connectionId } = await pending(a);
      const acc = await createAccount(a, { name: 'Stop me', type: 'checking' });
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', accountId: acc.id },
        { externalKey: 'key-b', create: { name: 'Keep syncing', type: 'savings' } },
      ]);
      await t.owner.insert(transaction).values({
        householdId: a.householdId,
        accountId: acc.id,
        dedupeHash: 'stop-keep-me',
        bookingDate: '2026-10-01',
        amount: -100,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'kept',
        source: 'connector',
      });

      const result = await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', ignore: true },
      ]);

      expect(result.linked).toEqual([]);
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links.map((l) => l.externalKey)).toEqual(['key-b']);
      const [account] = await t.owner
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.id, acc.id));
      expect(account).toMatchObject({ connectionId: null, externalId: null, archivedAt: null });
      const kept = await t.owner
        .select()
        .from(transaction)
        .where(eq(transaction.accountId, acc.id));
      expect(kept).toHaveLength(1);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row!.status).toBe('active');

      // It can be linked again later, to the same account.
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', accountId: acc.id },
      ]);
      const relinked = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(relinked.map((l) => l.externalKey).sort()).toEqual(['key-a', 'key-b']);
    });

    it('stopping an account needs no provider call and works when the bank no longer lists it', async () => {
      const { deps, connectionId, banking } = await pending(a);
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', create: { name: 'Gone', type: 'checking' } },
      ]);
      const callsBefore = banking.calls.length;
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-a', ignore: true },
        { externalKey: 'never-linked', ignore: true },
      ]);
      expect(banking.calls.length).toBe(callsBefore);
      expect(
        await t.owner
          .select()
          .from(connectionAccount)
          .where(eq(connectionAccount.connectionId, connectionId)),
      ).toEqual([]);
    });

    it('rejects ignore combined with accountId or create', async () => {
      const { deps, connectionId } = await pending(a);
      await expect(
        linkConnectionAccounts(a, deps, connectionId, [
          { externalKey: 'key-a', ignore: true, create: { name: 'x', type: 'cash' } },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('a revoked connection fails with the connection_revoked code', async () => {
      const { deps, connectionId } = await pending(a);
      await t.owner
        .update(connection)
        .set({ status: 'revoked' })
        .where(eq(connection.id, connectionId));
      await expect(
        linkConnectionAccounts(a, deps, connectionId, [
          { externalKey: 'key-a', create: { name: 'x', type: 'cash' } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'connection_revoked' });
    });
  });

  describe('addTrading212Connection', () => {
    it('validates the key with getAccountSummary and stores the credentials encrypted', async () => {
      const t212 = fakeTrading212();
      const deps = makeDeps(undefined, t212);
      const result = await addTrading212Connection(a, deps, {
        apiKey: 'k-plain-123',
        apiSecret: 's-plain-456',
        displayName: 'My broker',
      });
      expect(t212.calls).toEqual(['getAccountSummary']);
      expect(deps.credentialsSeen).toEqual([{ apiKey: 'k-plain-123', apiSecret: 's-plain-456' }]);
      expect(result.externalAccounts).toMatchObject([{ externalKey: '4242', currency: 'EUR' }]);
      const [row] = await t.owner
        .select()
        .from(connection)
        .where(eq(connection.id, result.connectionId));
      expect(row).toMatchObject({
        provider: 'trading212',
        status: 'pending',
        displayName: 'My broker',
      });
      expect(row!.credentialsEnc).not.toContain('k-plain');
      expect(
        JSON.parse(
          decryptSecret(row!.credentialsEnc!, TEST_KEY, `connection:${row!.id}:credentials`),
        ),
      ).toEqual({
        apiKey: 'k-plain-123',
        apiSecret: 's-plain-456',
      });
    });

    it('stores nothing when the provider rejects the credentials', async () => {
      const t212 = fakeTrading212();
      t212.failSummary = new ProviderAuthError();
      const before = await t.owner
        .select()
        .from(connection)
        .where(eq(connection.householdId, b.householdId));
      await expect(
        addTrading212Connection(b, makeDeps(undefined, t212), {
          apiKey: 'k',
          apiSecret: 's',
          displayName: 'Bad',
        }),
      ).rejects.toBeInstanceOf(ProviderAuthError);
      const after = await t.owner
        .select()
        .from(connection)
        .where(eq(connection.householdId, b.householdId));
      expect(after).toHaveLength(before.length);
    });

    it('links the single Trading 212 account', async () => {
      const t212 = fakeTrading212();
      const deps = makeDeps(undefined, t212);
      const { connectionId } = await addTrading212Connection(a, deps, {
        apiKey: 'k',
        apiSecret: 's',
        displayName: 'Broker 2',
      });
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: '4242', create: { name: 'Trading 212', type: 'investment' } },
      ]);
      const [link] = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(link).toMatchObject({ externalKey: '4242', externalUid: '4242', currency: 'EUR' });
    });

    it('is forbidden for viewers', async () => {
      await expect(
        addTrading212Connection(withRole(a, 'viewer'), makeDeps(undefined, fakeTrading212()), {
          apiKey: 'k',
          apiSecret: 's',
          displayName: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('updateTrading212Credentials', () => {
    /** An expired, linked Trading 212 connection (as after the key was revoked at the broker). */
    async function expiredBroker(ctx: ServiceCtx) {
      const t212 = fakeTrading212();
      const deps = makeDeps(undefined, t212);
      const { connectionId } = await addTrading212Connection(ctx, deps, {
        apiKey: 'old-key',
        apiSecret: 'old-secret',
        displayName: 'Broker',
      });
      await linkConnectionAccounts(ctx, deps, connectionId, [
        { externalKey: '4242', create: { name: 'Trading 212', type: 'investment' } },
      ]);
      await t.owner
        .update(connection)
        .set({
          status: 'expired',
          nextSyncAt: null,
          consecutiveFailures: 3,
          lastErrorCode: 'auth',
          lastErrorMessage: 'The provider rejected the credentials',
        })
        .where(eq(connection.id, connectionId));
      const [before] = await t.owner
        .select()
        .from(connection)
        .where(eq(connection.id, connectionId));
      return { t212, deps, connectionId, before: before! };
    }
    const fresh = { apiKey: 'new-key', apiSecret: 'new-secret' };

    it('re-encrypts the new key pair, reactivates the connection and schedules a sync now', async () => {
      const at = new Date('2026-10-18T12:00:00.000Z');
      const { t212, connectionId, before } = await expiredBroker(a);
      const deps = makeDeps(undefined, t212, () => at);
      await updateTrading212Credentials(a, deps, connectionId, {
        apiKey: ' new-key ',
        apiSecret: 'new-secret',
      });
      expect(t212.calls.at(-1)).toBe('getAccountSummary');
      expect(deps.credentialsSeen).toEqual([fresh]);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row).toMatchObject({
        status: 'active',
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      expect(row!.nextSyncAt?.toISOString()).toBe(at.toISOString());
      expect(row!.credentialsEnc).not.toBe(before.credentialsEnc);
      expect(row!.credentialsEnc).not.toContain('new-key');
      expect(
        JSON.parse(
          decryptSecret(row!.credentialsEnc!, TEST_KEY, `connection:${connectionId}:credentials`),
        ),
      ).toEqual(fresh);
      // The same account stays linked.
      const links = await t.owner
        .select()
        .from(connectionAccount)
        .where(eq(connectionAccount.connectionId, connectionId));
      expect(links).toHaveLength(1);
    });

    it('refuses keys of a different Trading 212 account and changes nothing', async () => {
      const { t212, connectionId, before } = await expiredBroker(a);
      t212.summary = { ...t212.summary, externalUid: '9999' };
      await expect(
        updateTrading212Credentials(a, makeDeps(undefined, t212), connectionId, fresh),
      ).rejects.toMatchObject({ name: 'ValidationError', code: 'different_account' });
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row).toEqual(before);
    });

    it('stores nothing when the provider rejects the new keys', async () => {
      const { t212, connectionId, before } = await expiredBroker(a);
      t212.failSummary = new ProviderAuthError();
      await expect(
        updateTrading212Credentials(a, makeDeps(undefined, t212), connectionId, fresh),
      ).rejects.toBeInstanceOf(ProviderAuthError);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row).toEqual(before);
    });

    it('is refused while a sync holds the connection lock, before calling the broker', async () => {
      const { t212, connectionId, before } = await expiredBroker(a);
      const callsBefore = t212.calls.length;
      const release = await holdSyncLock(connectionId);
      try {
        const error = await updateTrading212Credentials(
          a,
          makeDeps(undefined, t212),
          connectionId,
          fresh,
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({ code: 'sync_in_progress' });
      } finally {
        await release();
      }
      expect(t212.calls).toHaveLength(callsBefore);
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row).toEqual(before);
    });

    it('is forbidden for viewers and unknown to other households and bank connections', async () => {
      const { t212, connectionId } = await expiredBroker(a);
      const deps = makeDeps(undefined, t212);
      await expect(
        updateTrading212Credentials(withRole(a, 'viewer'), deps, connectionId, fresh),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        updateTrading212Credentials(b, deps, connectionId, fresh),
      ).rejects.toBeInstanceOf(NotFoundError);
      const bank = await consent(a);
      const { connectionId: bankId } = await completeBankConsent(a, bank.deps, {
        state: bank.state,
        code: 'c',
      });
      await expect(updateTrading212Credentials(a, deps, bankId, fresh)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('validates the input', async () => {
      const { t212, connectionId } = await expiredBroker(a);
      await expect(
        updateTrading212Credentials(a, makeDeps(undefined, t212), connectionId, {
          apiKey: '',
          apiSecret: 's',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('listBanks', () => {
    it('maps the provider list, caches per country for 24 hours and fails typed when unconfigured', async () => {
      const banking = fakeBanking();
      banking.listAspsps = async (country) => {
        banking.calls.push(`listAspsps:${country}`);
        return [
          {
            name: 'Test Bank',
            country,
            maximumConsentValiditySeconds: 90 * 86_400,
            logo: 'https://logos.example/test.png',
            beta: true,
            requiredPsuHeaders: [],
            psuTypes: ['personal'],
          },
          {
            name: 'Plain Bank',
            country,
            logo: 'http://insecure.example/x.png',
            requiredPsuHeaders: [],
            psuTypes: [],
          },
        ];
      };
      let clock = new Date('2026-10-18T09:00:00Z');
      const deps = makeDeps(banking, undefined, () => clock);

      const pt = await listBanks(a, deps, 'PT');
      expect(pt).toEqual([
        {
          name: 'Test Bank',
          country: 'PT',
          logoUrl: 'https://logos.example/test.png',
          beta: true,
          maxConsentDays: 90,
        },
        { name: 'Plain Bank', country: 'PT' },
      ]);
      await listBanks(withRole(a, 'viewer'), deps, 'PT');
      expect(banking.calls.filter((c) => c === 'listAspsps:PT')).toHaveLength(1);

      await listBanks(a, deps, 'ES');
      expect(banking.calls).toContain('listAspsps:ES');

      clock = new Date(clock.getTime() + 24 * 3_600_000 + 1);
      await listBanks(a, deps, 'PT');
      expect(banking.calls.filter((c) => c === 'listAspsps:PT')).toHaveLength(2);

      await expect(listBanks(a, deps, 'pt')).rejects.toBeInstanceOf(ValidationError);
      await expect(listBanks(a, makeDeps(undefined, undefined), 'PT')).rejects.toBeInstanceOf(
        BankingNotConfiguredError,
      );
    });

    it('does not cache a failed provider call', async () => {
      const banking = fakeBanking();
      let fail = true;
      const original = banking.listAspsps;
      banking.listAspsps = async (country) => {
        if (fail) throw new Error('boom');
        return original(country);
      };
      const deps = makeDeps(banking, undefined);
      await expect(listBanks(a, deps, 'PT')).rejects.toThrow('boom');
      fail = false;
      await expect(listBanks(a, deps, 'PT')).resolves.toHaveLength(1);
    });
  });

  describe('listConnectionAccounts', () => {
    it('lists the provider accounts with the IBAN tail only, stable-key flag and current link', async () => {
      const banking = fakeBanking();
      banking.sessionAccounts = [
        ACCOUNT_A,
        ACCOUNT_B,
        {
          externalUid: 'uid-c',
          externalKey: 'uid-c',
          name: 'Card',
          currency: 'EUR',
          stableKey: false,
        },
      ];
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      const first = await listConnectionAccounts(a, deps, connectionId);
      expect(first).toEqual([
        {
          externalKey: 'key-a',
          name: 'Current',
          ibanLast4: '0001',
          currency: 'EUR',
          stableKey: true,
          accountId: null,
        },
        {
          externalKey: 'key-b',
          name: 'Savings',
          ibanLast4: '0002',
          currency: 'EUR',
          stableKey: true,
          accountId: null,
        },
        { externalKey: 'uid-c', name: 'Card', currency: 'EUR', stableKey: false, accountId: null },
      ]);
      expect(JSON.stringify(first)).not.toContain('XX00TEST');

      const existing = await createAccount(a, { name: 'Mine', type: 'checking', currency: 'EUR' });
      await linkConnectionAccounts(a, deps, connectionId, [
        { externalKey: 'key-b', accountId: existing.id },
      ]);
      const after = await listConnectionAccounts(a, deps, connectionId);
      expect(after.map((x) => [x.externalKey, x.accountId])).toEqual([
        ['key-a', null],
        ['key-b', existing.id],
        ['uid-c', null],
      ]);
    });

    it('serves the accounts cached at consent without any provider call', async () => {
      const banking = fakeBanking();
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row!.externalAccountsEnc).not.toContain('XX00TEST');
      // Were the provider asked, it would answer differently (and `getSession` would be logged).
      banking.pendingAccounts = [{ uid: 'uid-z' }];
      banking.calls.length = 0;
      const listed = await listConnectionAccounts(a, deps, connectionId);
      expect(listed.map((x) => x.externalKey)).toEqual(['key-a', 'key-b']);
      expect(listed[0]).toMatchObject({ ibanLast4: '0001', stableKey: true });
      expect(banking.calls).toEqual([]);
    });

    it('falls back to the provider when the cache cannot be read', async () => {
      const banking = fakeBanking();
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      await t.owner
        .update(connection)
        .set({ externalAccountsEnc: 'not-a-valid-token' })
        .where(eq(connection.id, connectionId));
      banking.calls.length = 0;
      const listed = await listConnectionAccounts(a, deps, connectionId);
      expect(listed.map((x) => x.externalKey)).toEqual(['key-a', 'key-b']);
      expect(banking.calls).toEqual(['getSession']);
    });

    it('does not cache an empty account list', async () => {
      const banking = fakeBanking();
      banking.sessionAccounts = [];
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      const [row] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      expect(row!.externalAccountsEnc).toBeNull();
    });

    describe('without a cache (connection from before it existed)', () => {
      async function oldConnection() {
        const banking = fakeBanking();
        const { deps, state } = await consent(a, banking);
        const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
        await dropAccountsCache(connectionId);
        banking.pendingAccounts = [{ uid: 'uid-a' }, { uid: 'uid-b' }];
        banking.accountDetails = { 'uid-a': ACCOUNT_A, 'uid-b': ACCOUNT_B };
        return { banking, deps, connectionId };
      }

      it('skips an account whose details the provider rejects and returns the others', async () => {
        const { banking, deps, connectionId } = await oldConnection();
        const details = banking.getAccountDetails;
        banking.getAccountDetails = async (uid, opts) => {
          if (uid === 'uid-a')
            throw new ProviderResponseError('rejected the request (HTTP 422)', 422);
          return details(uid, opts);
        };
        const listed = await listConnectionAccounts(a, deps, connectionId);
        expect(listed.map((x) => x.externalKey)).toEqual(['key-b']);
      });

      it('rethrows the first error when every account is rejected', async () => {
        const { banking, deps, connectionId } = await oldConnection();
        banking.getAccountDetails = async (uid) => {
          throw new ProviderResponseError(`rejected ${uid} (HTTP 422)`, 422);
        };
        await expect(listConnectionAccounts(a, deps, connectionId)).rejects.toMatchObject({
          name: 'ProviderResponseError',
          message: 'rejected uid-a (HTTP 422)',
        });
      });

      it('still propagates rate-limit errors instead of skipping the account', async () => {
        const { banking, deps, connectionId } = await oldConnection();
        banking.getAccountDetails = async () => {
          throw new ProviderRateLimitError(1000, 'rate limit exceeded (HTTP 429)');
        };
        await expect(listConnectionAccounts(a, deps, connectionId)).rejects.toBeInstanceOf(
          ProviderRateLimitError,
        );
      });
    });

    it('resolves a uid-only session (GET /sessions shape) through account details', async () => {
      const banking = fakeBanking();
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      await dropAccountsCache(connectionId);
      banking.pendingAccounts = [{ uid: 'uid-a' }, { uid: 'uid-b', identificationHash: 'h' }];
      banking.accountDetails = { 'uid-a': ACCOUNT_A, 'uid-b': ACCOUNT_B };
      banking.calls.length = 0;
      const listed = await listConnectionAccounts(a, deps, connectionId);
      expect(listed.map((x) => x.externalKey)).toEqual([
        ACCOUNT_A.externalKey,
        ACCOUNT_B.externalKey,
      ]);
      expect(banking.calls).toEqual([
        'getSession',
        'getAccountDetails:uid-a',
        'getAccountDetails:uid-b',
      ]);
    });

    it('sends the PSU headers with the account details calls, and none when absent', async () => {
      const banking = fakeBanking();
      const { deps, state } = await consent(a, banking);
      const { connectionId } = await completeBankConsent(a, deps, { state, code: 'c' });
      await dropAccountsCache(connectionId);
      banking.pendingAccounts = [{ uid: 'uid-a' }];
      banking.accountDetails = { 'uid-a': ACCOUNT_A };
      const psu = { ipAddress: '203.0.113.7', userAgent: 'Agent/1.0' };
      await listConnectionAccounts(a, deps, connectionId, psu);
      const mine = await createAccount(a, { name: 'Mine', type: 'checking', currency: 'EUR' });
      await linkConnectionAccounts(
        a,
        deps,
        connectionId,
        [{ externalKey: ACCOUNT_A.externalKey, accountId: mine.id }],
        psu,
      );
      await listConnectionAccounts(a, deps, connectionId);
      expect(banking.detailsPsu.slice(0, 2)).toEqual([psu, psu]);
      expect(banking.detailsPsu.at(-1)).toBeUndefined();
    });

    it('lists the single Trading 212 account, is writer-only and household scoped', async () => {
      const deps = makeDeps(undefined, fakeTrading212());
      const { connectionId } = await addTrading212Connection(a, deps, {
        apiKey: 'k',
        apiSecret: 's',
        displayName: 'Broker',
      });
      expect(await listConnectionAccounts(a, deps, connectionId)).toEqual([
        { externalKey: '4242', name: 'Broker', currency: 'EUR', stableKey: true, accountId: null },
      ]);
      await expect(
        listConnectionAccounts(withRole(a, 'viewer'), deps, connectionId),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listConnectionAccounts(b, deps, connectionId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(listConnectionAccounts(a, deps, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listConnections', () => {
    it('never returns secrets, includes linked accounts and is household scoped', async () => {
      const t212 = fakeTrading212();
      const deps = makeDeps(undefined, t212);
      const h = await t.household();
      const { connectionId } = await addTrading212Connection(h, deps, {
        apiKey: 'api-key-visible?',
        apiSecret: 'api-secret-visible?',
        displayName: 'Listed',
      });
      await linkConnectionAccounts(h, deps, connectionId, [
        { externalKey: '4242', create: { name: 'T212', type: 'investment' } },
      ]);
      const listed = await listConnections(h);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: connectionId,
        provider: 'trading212',
        status: 'active',
        displayName: 'Listed',
      });
      expect(listed[0]!.accounts).toHaveLength(1);
      const [raw] = await t.owner.select().from(connection).where(eq(connection.id, connectionId));
      const json = JSON.stringify(listed);
      expect(json).not.toContain('api-key-visible');
      expect(json).not.toContain('api-secret-visible');
      expect(json).not.toContain(raw!.credentialsEnc!);
      expect(Object.keys(listed[0]!)).not.toContain('credentialsEnc');
      expect(Object.keys(listed[0]!)).not.toContain('externalSessionIdEnc');
      expect(await listConnections(await t.household())).toEqual([]);
      // A viewer may read.
      await expect(listConnections(withRole(h, 'viewer'))).resolves.toHaveLength(1);
    });
  });

  describe('removeConnection', () => {
    it('revokes the provider session, keeps transactions and unlinks the accounts', async () => {
      const c = await consent(a);
      const { connectionId } = await completeBankConsent(a, c.deps, { state: c.state, code: 'c' });
      const acc = await createAccount(a, { name: 'To unlink', type: 'checking' });
      await linkConnectionAccounts(a, c.deps, connectionId, [
        { externalKey: 'key-a', accountId: acc.id },
      ]);
      await t.owner.insert(transaction).values({
        householdId: a.householdId,
        accountId: acc.id,
        dedupeHash: 'keep-me',
        bookingDate: '2026-10-01',
        amount: -100,
        currency: 'EUR',
        status: 'booked',
        rawDescription: 'kept',
        source: 'connector',
      });

      const result = await removeConnection(a, c.deps, connectionId);

      expect(result).toEqual({ providerSessionRevoked: true });
      expect(c.banking.deletedSessions).toEqual(['session-1-secret']);
      expect(
        await t.owner.select().from(connection).where(eq(connection.id, connectionId)),
      ).toEqual([]);
      expect(
        await t.owner
          .select()
          .from(connectionAccount)
          .where(eq(connectionAccount.connectionId, connectionId)),
      ).toEqual([]);
      const [account] = await t.owner
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.id, acc.id));
      expect(account).toMatchObject({ connectionId: null, externalId: null });
      const kept = await t.owner
        .select()
        .from(transaction)
        .where(and(eq(transaction.accountId, acc.id)));
      expect(kept).toHaveLength(1);
    });

    it('still removes the connection when the provider cannot revoke the session', async () => {
      const c = await consent(a);
      const { connectionId } = await completeBankConsent(a, c.deps, { state: c.state, code: 'c' });
      c.banking.failDeleteSession = true;
      await expect(removeConnection(a, c.deps, connectionId)).resolves.toEqual({
        providerSessionRevoked: false,
      });
      expect(
        await t.owner.select().from(connection).where(eq(connection.id, connectionId)),
      ).toEqual([]);
    });

    it('is forbidden for viewers and not found across households', async () => {
      const c = await consent(a);
      const { connectionId } = await completeBankConsent(a, c.deps, { state: c.state, code: 'c' });
      await expect(
        removeConnection(withRole(a, 'viewer'), c.deps, connectionId),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeConnection(b, c.deps, connectionId)).rejects.toBeInstanceOf(NotFoundError);
      expect(c.banking.deletedSessions).toEqual([]);
    });
  });
});
