import type {
  ExternalAccount,
  PsuHeaders,
  HistoryPage,
  ProviderBalance,
  ProviderPie,
  ProviderPieInstrument,
  ProviderPosition,
  ProviderTx,
  Trading212Summary,
} from '@arfolio/connectors';
import type { ConnectorDeps, EnableBankingPort, Trading212Port } from '../src/index.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export const ACCOUNT_A: ExternalAccount = {
  externalUid: 'uid-a-1',
  externalKey: 'key-a',
  name: 'Current',
  currency: 'EUR',
  iban: 'XX00TEST0000000001',
};
export const ACCOUNT_B: ExternalAccount = {
  externalUid: 'uid-b-1',
  externalKey: 'key-b',
  name: 'Savings',
  currency: 'EUR',
  iban: 'XX00TEST0000000002',
};

export function tx(over: Partial<ProviderTx> = {}): ProviderTx {
  return {
    externalId: 'e1',
    bookingDate: '2026-10-10',
    amount: -1250,
    currency: 'EUR',
    description: 'Coffee shop',
    status: 'booked',
    ...over,
  };
}

export type FakeBanking = EnableBankingPort & {
  /** Everything the engine asked for, in order. */
  calls: string[];
  states: string[];
  deletedSessions: string[];
  /** Accounts the next createSession returns (the session's accounts). */
  sessionAccounts: ExternalAccount[];
  validUntil: string | undefined;
  /** Uid-only entries the next getSession returns (GET /sessions shape), resolved via details. */
  pendingAccounts: Array<{ uid: string; identificationHash?: string }>;
  /** Details getAccountDetails returns per uid. */
  accountDetails: Record<string, ExternalAccount>;
  /** PSU headers each getAccountDetails call carried. */
  detailsPsu: Array<PsuHeaders | undefined>;
  /** Per external uid: rows, or a function of the call number (1-based) that may throw. */
  txs: Record<string, ProviderTx[] | ((call: number) => ProviderTx[])>;
  balances: Record<string, ProviderBalance[]>;
  failDeleteSession: boolean;
  txRanges: Array<{ uid: string; dateFrom: string; dateTo: string }>;
  /** PSU headers each balances/transactions call carried (undefined when none were passed). */
  psu: Array<{ uid: string; call: 'balances' | 'transactions'; headers: PsuHeaders | undefined }>;
  /** Per external uid: how many page requests a listTransactions call makes (default 1). */
  pages: Record<string, number>;
  /** Per external uid: how many unmappable rows the provider call reports as skipped. */
  skippedRows: Record<string, number>;
  /** Runs at the start of every listTransactions call (e.g. to change the DB mid-run). */
  beforeTransactions?: (uid: string) => Promise<void>;
};

export function fakeBanking(sessionOffset = 0): FakeBanking {
  let sessionCount = sessionOffset;
  const callCounts = new Map<string, number>();
  const fake: FakeBanking = {
    calls: [],
    states: [],
    deletedSessions: [],
    sessionAccounts: [ACCOUNT_A, ACCOUNT_B],
    validUntil: '2027-01-15T00:00:00.000Z',
    pendingAccounts: [],
    accountDetails: {},
    detailsPsu: [],
    txs: {},
    balances: {},
    failDeleteSession: false,
    txRanges: [],
    psu: [],
    skippedRows: {},
    pages: {},
    async listAspsps(country) {
      fake.calls.push(`listAspsps:${country}`);
      return [
        {
          name: 'Test Bank',
          country,
          maximumConsentValiditySeconds: 90 * 86_400,
          requiredPsuHeaders: [],
          psuTypes: ['personal'],
        },
      ];
    },
    async startAuth(input) {
      fake.calls.push('startAuth');
      fake.states.push(input.state);
      return { url: `https://bank.example/auth?s=${input.state.slice(0, 6)}` };
    },
    async createSession() {
      sessionCount += 1;
      fake.calls.push('createSession');
      return {
        sessionId: `session-${sessionCount}-secret`,
        ...(fake.validUntil ? { validUntil: fake.validUntil } : {}),
        accounts: fake.sessionAccounts,
        pendingAccounts: [],
      };
    },
    async getSession(id) {
      fake.calls.push('getSession');
      return {
        sessionId: id,
        accounts: fake.pendingAccounts.length > 0 ? [] : fake.sessionAccounts,
        pendingAccounts: fake.pendingAccounts,
      };
    },
    async getAccountDetails(uid, opts) {
      fake.calls.push(`getAccountDetails:${uid}`);
      fake.detailsPsu.push(opts?.psuHeaders);
      const found = fake.accountDetails[uid];
      if (!found) throw new Error(`no details for ${uid}`);
      return found;
    },
    async deleteSession(id) {
      fake.calls.push('deleteSession');
      fake.deletedSessions.push(id);
      if (fake.failDeleteSession) throw new Error('bank unreachable');
    },
    async getBalances(uid, opts) {
      fake.calls.push(`getBalances:${uid}`);
      fake.psu.push({ uid, call: 'balances', headers: opts?.psuHeaders });
      return fake.balances[uid] ?? [];
    },
    async listTransactions(uid, opts) {
      fake.calls.push(`listTransactions:${uid}`);
      fake.txRanges.push({ uid, dateFrom: opts.dateFrom, dateTo: opts.dateTo });
      fake.psu.push({ uid, call: 'transactions', headers: opts.psuHeaders });
      await fake.beforeTransactions?.(uid);
      for (let i = 0; i < (fake.pages[uid] ?? 1); i++) opts.onPage?.();
      for (let i = 0; i < (fake.skippedRows[uid] ?? 0); i++) opts.onSkippedRow?.();
      const n = (callCounts.get(uid) ?? 0) + 1;
      callCounts.set(uid, n);
      const rows = fake.txs[uid] ?? [];
      return typeof rows === 'function' ? rows(n) : rows;
    },
  };
  return fake;
}

export type FakeTrading212 = Trading212Port & {
  calls: string[];
  summary: Trading212Summary;
  positions: ProviderPosition[];
  history: HistoryPage;
  dividends: HistoryPage;
  failSummary?: Error;
  pies: ProviderPie[];
  pieNames: Record<string, string>;
  pieInstruments: Record<string, ProviderPieInstrument[]>;
  failPies?: Error;
  since: Array<string | undefined>;
};

export function fakeTrading212(): FakeTrading212 {
  const fake: FakeTrading212 = {
    calls: [],
    since: [],
    summary: {
      externalUid: '4242',
      currency: 'EUR',
      totalValue: 150_000,
      cash: 50_000,
      cashAvailableToTrade: 40_000,
      investmentsValue: 100_000,
    },
    positions: [],
    pies: [],
    pieNames: {},
    pieInstruments: {},
    history: { items: [], incomplete: false },
    dividends: { items: [], incomplete: false },
    async getAccountSummary() {
      fake.calls.push('getAccountSummary');
      if (fake.failSummary) throw fake.failSummary;
      return fake.summary;
    },
    async getPositions() {
      fake.calls.push('getPositions');
      return fake.positions;
    },
    async listPies() {
      fake.calls.push('listPies');
      if (fake.failPies) throw fake.failPies;
      return fake.pies;
    },
    async getPieDetail(id) {
      fake.calls.push(`getPieDetail:${id}`);
      return { name: fake.pieNames[id] ?? `Pie ${id}`, instruments: fake.pieInstruments[id] ?? [] };
    },
    async listTransactions(opts) {
      fake.calls.push('listTransactions');
      fake.since.push(opts.since);
      return fake.history;
    },
    async listDividends(opts) {
      fake.calls.push('listDividends');
      fake.since.push(opts.since);
      return fake.dividends;
    },
  };
  return fake;
}

export function makeDeps(
  banking: FakeBanking | undefined,
  t212: FakeTrading212 | undefined,
  now: () => Date = () => new Date(),
): ConnectorDeps & { credentialsSeen: Array<{ apiKey: string; apiSecret: string }> } {
  const credentialsSeen: Array<{ apiKey: string; apiSecret: string }> = [];
  return {
    encryptionKey: TEST_KEY,
    ...(banking ? { enableBanking: banking } : {}),
    bankRedirectUrl: 'https://pfm.example/bank/callback',
    trading212: (credentials) => {
      credentialsSeen.push(credentials);
      return t212 ?? fakeTrading212();
    },
    now,
    credentialsSeen,
  };
}
