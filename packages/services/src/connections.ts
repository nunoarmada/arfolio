import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ProviderResponseError,
  type EnableBankingClient,
  type ExternalAccount,
  type PsuHeaders,
  type Trading212Client,
} from '@arfolio/connectors';
import { decryptSecret, encryptSecret } from '@arfolio/core/server';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertUuid,
  ConflictError,
  currencyCode,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from './context.js';

const { connection, connectionAccount, consentState, financialAccount, syncRun } = schema;

/** The slice of the Enable Banking client the services use; tests inject fakes. */
export type EnableBankingPort = Pick<
  EnableBankingClient,
  | 'listAspsps'
  | 'startAuth'
  | 'createSession'
  | 'getSession'
  | 'getAccountDetails'
  | 'deleteSession'
  | 'getBalances'
  | 'listTransactions'
>;

/** The slice of the Trading 212 client the services use. */
export type Trading212Port = Pick<
  Trading212Client,
  | 'getAccountSummary'
  | 'getPositions'
  | 'listPies'
  | 'getPieDetail'
  | 'listTransactions'
  | 'listDividends'
>;

/** The history-export calls of the Trading 212 client (only the worker's enrichment job uses them). */
export type Trading212ExportPort = Pick<
  Trading212Client,
  'requestHistoryExport' | 'listHistoryExports' | 'downloadHistoryExport'
>;

/** Everything provider-related a service needs, injected so tests never touch the network. */
export type ConnectorDeps = {
  /** 32-byte key from `loadEncryptionKey`. */
  encryptionKey: Buffer;
  /** Absent when the installation has no Enable Banking credentials. */
  enableBanking?: EnableBankingPort;
  /** Where the bank sends the user back to (carries `code` and `state`). */
  bankRedirectUrl?: string;
  /** Builds a client for one set of Trading 212 credentials. */
  trading212: (credentials: {
    apiKey: string;
    apiSecret: string;
  }) => Trading212Port & Partial<Trading212ExportPort>;
  now?: () => Date;
};

const CONSENT_STATE_TTL_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_CONSENT_VALIDITY_MS = 90 * DAY_MS;

export class BankingNotConfiguredError extends Error {
  constructor() {
    super('Bank connections are not configured on this installation');
    this.name = 'BankingNotConfiguredError';
  }
}

export type ConsentStateErrorReason = 'unknown' | 'used' | 'expired' | 'user_mismatch';

export class ConsentStateError extends Error {
  constructor(readonly reason: ConsentStateErrorReason) {
    super(`Bank consent state is not valid (${reason})`);
    this.name = 'ConsentStateError';
  }
}

/** Advisory-lock key text for one connection's sync. */
export const syncLockKey = (connectionId: string) => `sync:${connectionId}`;

/**
 * Session-level advisory lock on a dedicated client: it is held across the several transactions
 * a sync uses, and Postgres frees it if the process dies. Null when another run holds it.
 */
export async function tryLock(
  db: Db,
  connectionId: string,
): Promise<{ release(): Promise<void> } | null> {
  const client = await db.$client.connect();
  const key = syncLockKey(connectionId);
  try {
    const res = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as ok',
      [key],
    );
    if (!res.rows[0]?.ok) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release(true);
    throw error;
  }
  return {
    async release() {
      try {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        client.release();
      } catch {
        // Dropping the connection releases the session lock.
        client.release(true);
      }
    },
  };
}

export const nowOf = (deps: { now?: () => Date }): Date => (deps.now ?? (() => new Date()))();

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** Each secret is bound to its row and field: a token copied elsewhere will not decrypt. */
export const secretAad = (
  connectionId: string,
  field: 'external_session_id' | 'credentials' | 'external_accounts',
) => `connection:${connectionId}:${field}`;

const cachedAccounts = z.array(
  z.object({
    externalUid: z.string().min(1),
    externalKey: z.string().min(1),
    name: z.string(),
    currency: z.string().min(1),
    iban: z.string().optional(),
    stableKey: z.literal(false).optional(),
  }),
);

/** Encrypts the accounts `POST /sessions` returned; null when there is nothing worth caching. */
function sealAccounts(
  deps: ConnectorDeps,
  connectionId: string,
  accounts: ExternalAccount[],
): string | null {
  if (accounts.length === 0) return null;
  return encryptSecret(
    JSON.stringify(accounts),
    deps.encryptionKey,
    secretAad(connectionId, 'external_accounts'),
  );
}

/** The cached accounts, or null when there is no cache or it cannot be decrypted or parsed. */
function readCachedAccounts(deps: ConnectorDeps, row: ConnectionRow): ExternalAccount[] | null {
  if (!row.externalAccountsEnc) return null;
  try {
    const parsed = cachedAccounts.safeParse(
      JSON.parse(
        decryptSecret(
          row.externalAccountsEnc,
          deps.encryptionKey,
          secretAad(row.id, 'external_accounts'),
        ),
      ),
    );
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

function requireBanking(deps: ConnectorDeps): { eb: EnableBankingPort; redirectUrl: string } {
  if (!deps.enableBanking || !deps.bankRedirectUrl) throw new BankingNotConfiguredError();
  return { eb: deps.enableBanking, redirectUrl: deps.bankRedirectUrl };
}

type ConnectionRow = typeof connection.$inferSelect;

async function loadConnection(
  ctx: ServiceCtx,
  id: string,
  provider?: ConnectionRow['provider'],
): Promise<ConnectionRow> {
  assertUuid(id, 'Connection');
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, id), eq(connection.householdId, ctx.householdId))),
  );
  if (!row || (provider !== undefined && row.provider !== provider)) {
    throw new NotFoundError('Connection');
  }
  return row;
}

export type BankSummary = {
  name: string;
  country: string;
  /** https logo URL from the provider; the UI may fall back to a monogram. */
  logoUrl?: string;
  beta?: boolean;
  /** Longest consent the bank allows, in whole days. */
  maxConsentDays?: number;
};

const BANK_LIST_TTL_MS = DAY_MS;
// Keyed by client instance so a replaced client (or a test fake) never sees another's entries.
const bankListCache = new WeakMap<
  EnableBankingPort,
  Map<string, { at: number; banks: BankSummary[] }>
>();

/**
 * Banks Enable Banking can connect to in `country` (ISO 3166 alpha-2). Cached in process for 24
 * hours per country; failures are not cached. Any member may read it.
 */
export async function listBanks(
  _ctx: ServiceCtx,
  deps: ConnectorDeps,
  country: string,
): Promise<BankSummary[]> {
  if (!deps.enableBanking) throw new BankingNotConfiguredError();
  const code = parseInput(
    z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166 country code'),
    country,
  );
  const eb = deps.enableBanking;
  const now = nowOf(deps).getTime();
  const perClient = bankListCache.get(eb) ?? new Map();
  bankListCache.set(eb, perClient);
  const hit = perClient.get(code);
  if (hit && now - hit.at < BANK_LIST_TTL_MS) return hit.banks;
  const banks = (await eb.listAspsps(code)).map((a): BankSummary => ({
    name: a.name,
    country: a.country,
    ...(a.logo !== undefined && a.logo.startsWith('https://') ? { logoUrl: a.logo } : {}),
    ...(a.beta !== undefined ? { beta: a.beta } : {}),
    ...(a.maximumConsentValiditySeconds !== undefined
      ? { maxConsentDays: Math.floor(a.maximumConsentValiditySeconds / 86_400) }
      : {}),
  }));
  perClient.set(code, { at: now, banks });
  return banks;
}

const startSchema = z.strictObject({
  aspspName: z.string().trim().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/, 'expected an ISO 3166 country code'),
  connectionId: z.string().optional(),
});

/**
 * Begins the bank consent: creates a one-shot `consent_state` (only its sha256 is stored) and
 * returns the bank's authorisation URL. With `connectionId` the consent renews that connection.
 */
export async function startBankConsent(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  rawInput: z.input<typeof startSchema>,
): Promise<{ redirectUrl: string }> {
  assertCanWrite(ctx);
  const input = parseInput(startSchema, rawInput);
  const { eb, redirectUrl } = requireBanking(deps);
  if (input.connectionId !== undefined) {
    await loadConnection(ctx, input.connectionId, 'enablebanking');
  }
  const aspsp = (await eb.listAspsps(input.country)).find((a) => a.name === input.aspspName);
  if (!aspsp) throw new ValidationError('Unknown bank', [], 'unknown_bank');
  const now = nowOf(deps);
  const validityMs =
    aspsp.maximumConsentValiditySeconds !== undefined
      ? aspsp.maximumConsentValiditySeconds * 1000
      : DEFAULT_CONSENT_VALIDITY_MS;

  const state = randomBytes(32).toString('base64url');
  const auth = await eb.startAuth({
    aspsp: { name: input.aspspName, country: input.country },
    state,
    redirectUrl,
    validUntil: new Date(now.getTime() + validityMs),
    psuType: 'personal',
  });
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.insert(consentState).values({
      householdId: ctx.householdId,
      stateHash: sha256Hex(state),
      connectionId: input.connectionId ?? null,
      userId: ctx.userId,
      aspspName: input.aspspName,
      aspspCountry: input.country,
      expiresAt: new Date(now.getTime() + CONSENT_STATE_TTL_MS),
    }),
  );
  return { redirectUrl: auth.url };
}

const completeSchema = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(2_048),
});

/**
 * Finishes the consent for the signed-in user. The state must belong to this household and user,
 * be unused and unexpired; it is marked used atomically before the code is exchanged, so a
 * replay or a race can never create two sessions. Creates the connection (pending until its
 * accounts are linked) or renews the one named in the state.
 */
export async function completeBankConsent(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  rawInput: z.input<typeof completeSchema>,
): Promise<{ connectionId: string; externalAccounts: ExternalAccount[] }> {
  assertCanWrite(ctx);
  const input = parseInput(completeSchema, rawInput);
  const { eb } = requireBanking(deps);
  const stateHash = sha256Hex(input.state);

  // A renewal rewrites the session secret a sync may be using: wait for no sync, and refuse
  // before the state or the one-shot code is spent, so the person can simply try again.
  const [pending] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ connectionId: consentState.connectionId })
      .from(consentState)
      .where(
        and(eq(consentState.stateHash, stateHash), eq(consentState.householdId, ctx.householdId)),
      ),
  );
  const lock = pending?.connectionId ? await tryLock(ctx.db, pending.connectionId) : null;
  if (pending?.connectionId && !lock) {
    throw new ConflictError('sync_in_progress', 'A sync is running for this connection');
  }
  try {
    return await completeConsent(ctx, deps, eb, input, stateHash);
  } finally {
    await lock?.release();
  }
}

async function completeConsent(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  eb: EnableBankingPort,
  input: z.output<typeof completeSchema>,
  stateHash: string,
): Promise<{ connectionId: string; externalAccounts: ExternalAccount[] }> {
  const now = nowOf(deps);
  const state = await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [row] = await tx
      .select()
      .from(consentState)
      .where(
        and(eq(consentState.stateHash, stateHash), eq(consentState.householdId, ctx.householdId)),
      );
    if (!row) throw new ConsentStateError('unknown');
    if (row.userId !== ctx.userId) throw new ConsentStateError('user_mismatch');
    if (row.usedAt !== null) throw new ConsentStateError('used');
    if (row.expiresAt <= now) throw new ConsentStateError('expired');
    const [claimed] = await tx
      .update(consentState)
      .set({ usedAt: now })
      .where(
        and(
          eq(consentState.id, row.id),
          isNull(consentState.usedAt),
          gt(consentState.expiresAt, now),
        ),
      )
      .returning({ id: consentState.id });
    if (!claimed) throw new ConsentStateError('used');
    return row;
  });

  const session = await eb.createSession(input.code);
  const validUntil = session.validUntil ? new Date(session.validUntil) : null;
  const consentExpiresAt = validUntil && !Number.isNaN(validUntil.getTime()) ? validUntil : null;

  const result = await persistSession(ctx, deps, state, session, consentExpiresAt, now).catch(
    async (error: unknown) => {
      // The one-shot code is spent and the session would be left dangling at the bank.
      await eb.deleteSession(session.sessionId).catch(() => undefined);
      throw error;
    },
  );

  if (result.connectionId === null) {
    // The connection was removed while the user was at the bank: do not leave the session behind.
    await eb.deleteSession(session.sessionId).catch(() => undefined);
    throw new NotFoundError('Connection');
  }
  if (result.previousSessionEnc) {
    // Best effort: the old session is superseded either way.
    try {
      await eb.deleteSession(
        decryptSecret(
          result.previousSessionEnc,
          deps.encryptionKey,
          secretAad(result.connectionId, 'external_session_id'),
        ),
      );
    } catch {
      // The old session simply expires at the bank.
    }
  }
  return { connectionId: result.connectionId, externalAccounts: session.accounts };
}

type ConsentRow = typeof consentState.$inferSelect;
type PersistResult = { connectionId: string | null; previousSessionEnc: string | null };

/** Stores the new session: creates the pending connection, or renews the one in the state. */
async function persistSession(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  state: ConsentRow,
  session: Awaited<ReturnType<EnableBankingPort['createSession']>>,
  consentExpiresAt: Date | null,
  now: Date,
): Promise<PersistResult> {
  return withHousehold(ctx.db, ctx.householdId, async (tx): Promise<PersistResult> => {
    if (state.connectionId === null) {
      const id = randomUUID();
      await tx.insert(connection).values({
        id,
        householdId: ctx.householdId,
        provider: 'enablebanking',
        displayName: state.aspspName,
        institutionName: state.aspspName,
        institutionCountry: state.aspspCountry,
        status: 'pending',
        externalSessionIdEnc: encryptSecret(
          session.sessionId,
          deps.encryptionKey,
          secretAad(id, 'external_session_id'),
        ),
        externalAccountsEnc: sealAccounts(deps, id, session.accounts),
        consentExpiresAt,
        createdBy: ctx.userId,
      });
      return { connectionId: id, previousSessionEnc: null };
    }

    const id = state.connectionId;
    const [current] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, id), eq(connection.householdId, ctx.householdId)))
      .for('update');
    if (!current) return { connectionId: null, previousSessionEnc: null };

    const links = await tx
      .select()
      .from(connectionAccount)
      .where(eq(connectionAccount.connectionId, id));
    // Session uids change on re-consent: relink on the stable key only. A key that is merely the
    // old uid cannot match, so such accounts are unlinked for the user to link again.
    const stable = new Map(
      session.accounts.filter((a) => a.stableKey !== false).map((a) => [a.externalKey, a]),
    );
    const unmatched: typeof links = [];
    let matched = 0;
    for (const link of links) {
      const next = stable.get(link.externalKey);
      if (next) {
        await tx
          .update(connectionAccount)
          .set({ externalUid: next.externalUid })
          .where(eq(connectionAccount.id, link.id));
        matched += 1;
      } else {
        unmatched.push(link);
      }
    }
    if (unmatched.length > 0) {
      await unlinkInTx(
        tx,
        ctx.householdId,
        unmatched.map((l) => l.id),
        unmatched.map((l) => l.accountId),
      );
    }
    await tx
      .update(connection)
      .set({
        externalSessionIdEnc: encryptSecret(
          session.sessionId,
          deps.encryptionKey,
          secretAad(id, 'external_session_id'),
        ),
        externalAccountsEnc: sealAccounts(deps, id, session.accounts),
        consentExpiresAt,
        status: matched > 0 ? 'active' : 'pending',
        nextSyncAt: matched > 0 ? now : null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(eq(connection.id, id));
    return { connectionId: id, previousSessionEnc: current.externalSessionIdEnc };
  });
}

async function unlinkInTx(
  tx: Tx,
  householdId: string,
  linkIds: string[],
  accountIds: string[],
): Promise<void> {
  if (linkIds.length === 0) return;
  await tx
    .delete(connectionAccount)
    .where(
      and(eq(connectionAccount.householdId, householdId), inArray(connectionAccount.id, linkIds)),
    );
  await tx
    .update(financialAccount)
    .set({ connectionId: null, externalId: null })
    .where(
      and(eq(financialAccount.householdId, householdId), inArray(financialAccount.id, accountIds)),
    );
}

/** The accounts the provider exposes for a connection, fetched with its stored secret. */
async function listExternalAccounts(
  deps: ConnectorDeps,
  row: ConnectionRow,
  psuHeaders?: PsuHeaders,
): Promise<ExternalAccount[]> {
  if (row.provider === 'enablebanking') {
    const cached = readCachedAccounts(deps, row);
    if (cached) return cached;
    const { eb } = requireBanking(deps);
    if (!row.externalSessionIdEnc) return [];
    const sessionId = decryptSecret(
      row.externalSessionIdEnc,
      deps.encryptionKey,
      secretAad(row.id, 'external_session_id'),
    );
    const session = await eb.getSession(sessionId);
    // GET /sessions/{id} lists accounts as bare uids: details only for those, one call each.
    // A bank rejecting one account's details (HTTP 4xx) must not hide the others; other errors
    // (rate limit, auth, unavailable) say the whole call cannot work and propagate.
    const detailed: ExternalAccount[] = [];
    let firstRejection: ProviderResponseError | undefined;
    for (const pending of session.pendingAccounts) {
      try {
        detailed.push(
          await eb.getAccountDetails(pending.uid, {
            ...(psuHeaders ? { psuHeaders } : {}),
            ...(pending.identificationHash
              ? { identificationHash: pending.identificationHash }
              : {}),
          }),
        );
      } catch (error) {
        if (!(error instanceof ProviderResponseError)) throw error;
        firstRejection ??= error;
      }
    }
    if (firstRejection && detailed.length === 0 && session.accounts.length === 0) {
      throw firstRejection;
    }
    return [...session.accounts, ...detailed];
  }
  if (!row.credentialsEnc) return [];
  const credentials = readCredentials(deps, row);
  const summary = await deps.trading212(credentials).getAccountSummary();
  return [
    {
      externalUid: summary.externalUid,
      externalKey: summary.externalUid,
      name: row.displayName,
      currency: summary.currency,
    },
  ];
}

export type ConnectionAccountOption = {
  externalKey: string;
  name: string;
  /** Last four characters only: the full IBAN never leaves the service. */
  ibanLast4?: string;
  currency: string;
  /** False when the key is session-scoped, so a re-consent cannot relink this account. */
  stableKey: boolean;
  /** The account currently linked to this provider account, if any. */
  accountId: string | null;
};

/**
 * The provider accounts of a connection (fetched with its stored secret) and what each is linked
 * to, so the link step works on reload and not only straight after the consent callback.
 */
export async function listConnectionAccounts(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  connectionId: string,
  /** PSU headers of the person at the screen, so the bank does not count the calls as unattended. */
  psu?: PsuHeaders,
): Promise<ConnectionAccountOption[]> {
  assertCanWrite(ctx);
  const row = await loadConnection(ctx, connectionId);
  const external = await listExternalAccounts(deps, row, psu);
  const links = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({
        externalKey: connectionAccount.externalKey,
        accountId: connectionAccount.accountId,
      })
      .from(connectionAccount)
      .where(
        and(
          eq(connectionAccount.householdId, ctx.householdId),
          eq(connectionAccount.connectionId, connectionId),
        ),
      ),
  );
  const linked = new Map(links.map((l) => [l.externalKey, l.accountId]));
  return external.map((e) => ({
    externalKey: e.externalKey,
    name: e.name,
    ...(e.iban !== undefined && e.iban.length >= 4 ? { ibanLast4: e.iban.slice(-4) } : {}),
    currency: e.currency,
    stableKey: e.stableKey !== false,
    accountId: linked.get(e.externalKey) ?? null,
  }));
}

const credentialsSchema = z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1) });

/** Decrypts a Trading 212 connection's credentials. Throws DecryptError on tampering or a wrong key. */
export function readCredentials(
  deps: Pick<ConnectorDeps, 'encryptionKey'>,
  row: Pick<ConnectionRow, 'id' | 'credentialsEnc'>,
): { apiKey: string; apiSecret: string } {
  const plain = decryptSecret(
    row.credentialsEnc ?? '',
    deps.encryptionKey,
    secretAad(row.id, 'credentials'),
  );
  return credentialsSchema.parse(JSON.parse(plain));
}

const linksSchema = z.array(
  z
    .strictObject({
      externalKey: z.string().min(1).max(500),
      accountId: z.string().optional(),
      create: z
        .strictObject({
          name: z.string().trim().min(1).max(120),
          type: z.enum(schema.ACCOUNT_TYPES),
        })
        .optional(),
      /** Stop syncing this provider account: the link goes, the account and its history stay. */
      ignore: z.literal(true).optional(),
    })
    .refine(
      (l) =>
        [l.accountId !== undefined, l.create !== undefined, l.ignore !== undefined].filter(Boolean)
          .length === 1,
      { message: 'give exactly one of accountId, create or ignore' },
    ),
);
export type ConnectionLink = z.input<typeof linksSchema>[number];

/**
 * Links provider accounts to existing or newly created accounts. The first link activates a
 * pending connection and schedules its first sync. Re-linking an account (or an external
 * account) on the same connection replaces the old link. `ignore` removes a provider account's
 * link (if any) so it stops syncing; the account and its transactions are kept.
 */
export async function linkConnectionAccounts(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  connectionId: string,
  rawLinks: ConnectionLink[],
  psu?: PsuHeaders,
): Promise<{ linked: Array<{ externalKey: string; accountId: string }> }> {
  assertCanWrite(ctx);
  assertUuid(connectionId, 'Connection');
  const links = parseInput(linksSchema, rawLinks);
  const row = await loadConnection(ctx, connectionId);
  if (row.status === 'revoked')
    throw new ValidationError('Connection is revoked', [], 'connection_revoked');
  // Stopping an account needs no provider call, and works for one the bank no longer lists.
  const external = links.some((l) => !l.ignore) ? await listExternalAccounts(deps, row, psu) : [];

  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    // Read after the provider call: a sync that starts while it runs stamps last_success_at with
    // its own start, so a link dated before that would look already synced and miss its history.
    const now = nowOf(deps);
    const linked: Array<{ externalKey: string; accountId: string }> = [];
    for (const link of links) {
      if (link.ignore) {
        const current = await tx
          .select()
          .from(connectionAccount)
          .where(
            and(
              eq(connectionAccount.connectionId, connectionId),
              eq(connectionAccount.externalKey, link.externalKey),
            ),
          );
        await unlinkInTx(
          tx,
          ctx.householdId,
          current.map((l) => l.id),
          current.map((l) => l.accountId),
        );
        continue;
      }
      const ext = external.find((e) => e.externalKey === link.externalKey);
      if (!ext) {
        throw new ValidationError(
          `Unknown provider account "${link.externalKey}"`,
          [],
          'unknown_provider_account',
        );
      }
      if (!currencyCode.safeParse(ext.currency).success) {
        throw new ValidationError(
          `Provider account "${link.externalKey}" has an invalid currency`,
          [],
          'currency_mismatch',
        );
      }

      // The external account may already point at another account of this connection.
      const sameKey = await tx
        .select()
        .from(connectionAccount)
        .where(
          and(
            eq(connectionAccount.connectionId, connectionId),
            eq(connectionAccount.externalKey, ext.externalKey),
          ),
        );
      await unlinkInTx(
        tx,
        ctx.householdId,
        sameKey.map((l) => l.id),
        sameKey.map((l) => l.accountId),
      );

      let accountId: string;
      if (link.create) {
        const [created] = await tx
          .insert(financialAccount)
          .values({
            householdId: ctx.householdId,
            name: link.create.name,
            type: link.create.type,
            currency: ext.currency,
            institutionName: row.institutionName,
            connectionId,
            externalId: ext.externalKey,
          })
          .returning({ id: financialAccount.id });
        accountId = created!.id;
      } else {
        accountId = link.accountId!;
        assertUuid(accountId, 'Account');
        const [account] = await tx
          .select()
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.id, accountId),
              eq(financialAccount.householdId, ctx.householdId),
            ),
          );
        if (!account || account.archivedAt) throw new NotFoundError('Account');
        if (account.currency !== ext.currency) {
          throw new ValidationError(
            `Account currency (${account.currency}) differs from the provider account (${ext.currency})`,
            [],
            'currency_mismatch',
          );
        }
        const [existing] = await tx
          .select()
          .from(connectionAccount)
          .where(
            and(
              eq(connectionAccount.householdId, ctx.householdId),
              eq(connectionAccount.accountId, accountId),
            ),
          );
        if (existing && existing.connectionId !== connectionId) {
          throw new ValidationError(
            'Account is already linked to another connection',
            [],
            'account_linked_elsewhere',
          );
        }
        if (existing) await unlinkInTx(tx, ctx.householdId, [existing.id], [accountId]);
        await tx
          .update(financialAccount)
          .set({ connectionId, externalId: ext.externalKey })
          .where(eq(financialAccount.id, accountId));
      }
      await tx.insert(connectionAccount).values({
        householdId: ctx.householdId,
        connectionId,
        accountId,
        externalUid: ext.externalUid,
        externalKey: ext.externalKey,
        currency: ext.currency,
        name: ext.name,
        // Same clock as `last_success_at`: the sync gives a link newer than that the first window.
        createdAt: now,
      });
      linked.push({ externalKey: ext.externalKey, accountId });
    }
    if (linked.length > 0 && row.status === 'pending') {
      await tx
        .update(connection)
        .set({ status: 'active', nextSyncAt: now })
        .where(eq(connection.id, connectionId));
    }
    return { linked };
  });
}

const trading212Schema = z.strictObject({
  apiKey: z.string().trim().min(1).max(500),
  apiSecret: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(120),
});

/** Validates the key pair against Trading 212 before anything is stored (as pending, encrypted). */
export async function addTrading212Connection(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  rawInput: z.input<typeof trading212Schema>,
): Promise<{ connectionId: string; externalAccounts: ExternalAccount[] }> {
  assertCanWrite(ctx);
  const input = parseInput(trading212Schema, rawInput);
  const summary = await deps
    .trading212({ apiKey: input.apiKey, apiSecret: input.apiSecret })
    .getAccountSummary();
  const id = randomUUID();
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.insert(connection).values({
      id,
      householdId: ctx.householdId,
      provider: 'trading212',
      displayName: input.displayName,
      institutionName: 'Trading 212',
      status: 'pending',
      credentialsEnc: encryptSecret(
        JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
        deps.encryptionKey,
        secretAad(id, 'credentials'),
      ),
      createdBy: ctx.userId,
    }),
  );
  return {
    connectionId: id,
    externalAccounts: [
      {
        externalUid: summary.externalUid,
        externalKey: summary.externalUid,
        name: input.displayName,
        currency: summary.currency,
      },
    ],
  };
}

const trading212CredentialsSchema = trading212Schema.pick({ apiKey: true, apiSecret: true });

/**
 * Replaces the key pair of a Trading 212 connection (the old one expired or was revoked). The
 * new keys must belong to the same Trading 212 account that is already linked, so a different
 * account's data can never flow into the linked one. Waits for no sync (the sync lock), then
 * reactivates the connection and schedules a sync right away.
 */
export async function updateTrading212Credentials(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  connectionId: string,
  rawInput: z.input<typeof trading212CredentialsSchema>,
): Promise<void> {
  assertCanWrite(ctx);
  const input = parseInput(trading212CredentialsSchema, rawInput);
  const row = await loadConnection(ctx, connectionId, 'trading212');
  if (row.status === 'revoked') {
    throw new ValidationError('Connection is revoked', [], 'connection_revoked');
  }
  const lock = await tryLock(ctx.db, row.id);
  if (!lock) throw new ConflictError('sync_in_progress', 'A sync is running for this connection');
  try {
    const summary = await deps.trading212(input).getAccountSummary();
    const now = nowOf(deps);
    await withHousehold(ctx.db, ctx.householdId, async (tx) => {
      const links = await tx
        .select({ externalKey: connectionAccount.externalKey })
        .from(connectionAccount)
        .where(
          and(
            eq(connectionAccount.householdId, ctx.householdId),
            eq(connectionAccount.connectionId, row.id),
          ),
        );
      if (links.length > 0 && !links.some((l) => l.externalKey === summary.externalUid)) {
        throw new ValidationError(
          'The keys belong to a different Trading 212 account',
          [],
          'different_account',
        );
      }
      await tx
        .update(connection)
        .set({
          credentialsEnc: encryptSecret(
            JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }),
            deps.encryptionKey,
            secretAad(row.id, 'credentials'),
          ),
          // A connection that was never linked stays pending: linking activates it.
          ...(links.length > 0 ? { status: 'active' as const, nextSyncAt: now } : {}),
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastErrorMessage: null,
        })
        .where(and(eq(connection.id, row.id), eq(connection.householdId, ctx.householdId)));
    });
  } finally {
    await lock.release();
  }
}

/**
 * Deletes a connection: the Enable Banking session is revoked best-effort (reported in the
 * result), linked accounts are unlinked and keep all their transactions.
 */
export async function removeConnection(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  id: string,
): Promise<{ providerSessionRevoked: boolean }> {
  assertCanWrite(ctx);
  const row = await loadConnection(ctx, id);
  // A running sync holds this lock: deleting under it would leave it writing to a removed row.
  const lock = await tryLock(ctx.db, row.id);
  if (!lock) throw new ConflictError('sync_in_progress', 'A sync is running for this connection');
  let providerSessionRevoked = false;
  try {
    if (row.provider === 'enablebanking' && row.externalSessionIdEnc && deps.enableBanking) {
      try {
        await deps.enableBanking.deleteSession(
          decryptSecret(
            row.externalSessionIdEnc,
            deps.encryptionKey,
            secretAad(row.id, 'external_session_id'),
          ),
        );
        providerSessionRevoked = true;
      } catch {
        // Reported through the result; the bank expires the session on its own.
      }
    }
    await withHousehold(ctx.db, ctx.householdId, async (tx) => {
      await tx
        .update(financialAccount)
        .set({ connectionId: null, externalId: null })
        .where(
          and(
            eq(financialAccount.householdId, ctx.householdId),
            eq(financialAccount.connectionId, row.id),
          ),
        );
      await tx
        .delete(connection)
        .where(and(eq(connection.id, row.id), eq(connection.householdId, ctx.householdId)));
    });
  } finally {
    await lock.release();
  }
  return { providerSessionRevoked };
}

/** Manual refresh allowance per provider: Enable Banking 2 per rolling day, Trading 212 1 per 5 minutes. */
const MANUAL_REFRESH_RULES = {
  enablebanking: { windowMs: DAY_MS, limit: 2, window: 'day' },
  trading212: { windowMs: 5 * 60_000, limit: 1, window: '5min' },
} as const satisfies Record<
  ConnectionRow['provider'],
  { windowMs: number; limit: number; window: 'day' | '5min' }
>;

export type ManualRefreshAllowance = {
  limit: number;
  remaining: number;
  /** When the allowance frees up (ISO); null while at least one refresh is left. */
  retryAt: string | null;
  window: 'day' | '5min';
};

/**
 * The single rule behind both the refusal in `requestManualSync` and the allowance shown in
 * `listConnections`. `recentStarts` are the start times of the connection's manual runs, newest
 * first; runs older than the rolling window are ignored.
 */
export function manualRefreshAllowance(
  provider: ConnectionRow['provider'],
  recentStarts: readonly Date[],
  now: Date,
): ManualRefreshAllowance {
  const rule = MANUAL_REFRESH_RULES[provider];
  const inWindow = recentStarts
    .filter((at) => at.getTime() > now.getTime() - rule.windowMs)
    .slice(0, rule.limit);
  const exhausted = inWindow.length >= rule.limit;
  return {
    limit: rule.limit,
    remaining: rule.limit - inWindow.length,
    retryAt: exhausted
      ? new Date(inWindow[rule.limit - 1]!.getTime() + rule.windowMs).toISOString()
      : null,
    window: rule.window,
  };
}

/** The connection's manual runs inside the longest rolling window, newest first, per connection. */
export async function recentManualRuns(
  tx: Tx,
  householdId: string,
  now: Date,
  connectionId?: string,
): Promise<Map<string, Date[]>> {
  const rows = await tx
    .select({ connectionId: syncRun.connectionId, startedAt: syncRun.startedAt })
    .from(syncRun)
    .where(
      and(
        eq(syncRun.householdId, householdId),
        eq(syncRun.trigger, 'manual'),
        gt(syncRun.startedAt, new Date(now.getTime() - DAY_MS)),
        connectionId === undefined ? undefined : eq(syncRun.connectionId, connectionId),
      ),
    )
    .orderBy(desc(syncRun.startedAt));
  const byConnection = new Map<string, Date[]>();
  for (const row of rows) {
    const list = byConnection.get(row.connectionId) ?? [];
    list.push(row.startedAt);
    byConnection.set(row.connectionId, list);
  }
  return byConnection;
}

export type ConnectionSummary = {
  id: string;
  provider: ConnectionRow['provider'];
  displayName: string;
  institutionName: string | null;
  institutionCountry: string | null;
  status: ConnectionRow['status'];
  consentExpiresAt: Date | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  nextSyncAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  manualRefresh: ManualRefreshAllowance;
  accounts: Array<{ accountId: string; externalKey: string; name: string; currency: string }>;
};

/** Connections with their linked accounts. Explicit columns: secrets never leave this module. */
export async function listConnections(
  ctx: ServiceCtx,
  opts: { now?: Date } = {},
): Promise<ConnectionSummary[]> {
  const now = opts.now ?? new Date();
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const rows = await tx
      .select({
        id: connection.id,
        provider: connection.provider,
        displayName: connection.displayName,
        institutionName: connection.institutionName,
        institutionCountry: connection.institutionCountry,
        status: connection.status,
        consentExpiresAt: connection.consentExpiresAt,
        lastSyncAt: connection.lastSyncAt,
        lastSuccessAt: connection.lastSuccessAt,
        nextSyncAt: connection.nextSyncAt,
        consecutiveFailures: connection.consecutiveFailures,
        lastErrorCode: connection.lastErrorCode,
        lastErrorMessage: connection.lastErrorMessage,
      })
      .from(connection)
      .where(eq(connection.householdId, ctx.householdId))
      .orderBy(asc(connection.createdAt), asc(connection.id));
    const links = await tx
      .select({
        connectionId: connectionAccount.connectionId,
        accountId: connectionAccount.accountId,
        externalKey: connectionAccount.externalKey,
        name: connectionAccount.name,
        currency: connectionAccount.currency,
      })
      .from(connectionAccount)
      .where(eq(connectionAccount.householdId, ctx.householdId))
      .orderBy(asc(connectionAccount.createdAt), asc(connectionAccount.id));
    const manualRuns = await recentManualRuns(tx, ctx.householdId, now);
    return rows.map((row) => ({
      ...row,
      manualRefresh: manualRefreshAllowance(row.provider, manualRuns.get(row.id) ?? [], now),
      accounts: links
        .filter((l) => l.connectionId === row.id)
        .map((l) => ({
          accountId: l.accountId,
          externalKey: l.externalKey,
          name: l.name,
          currency: l.currency,
        })),
    }));
  });
}
