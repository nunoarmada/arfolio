import type {
  Account,
  ConnectionSummary,
  AccountWithBalance,
  CategoryGroupWithCategories,
  RuleRow,
  TransactionListRow,
  TransactionLocation,
  TransactionMerchant,
} from '@arfolio/services';

/** Plain, client-safe shapes: no Date objects, only what the UI renders. */

export interface AccountDto {
  id: string;
  name: string;
  type: Account['type'];
  currency: string;
  institutionName: string | null;
  ibanLast4: string | null;
  openingBalance: number;
  openingBalanceDate: string | null;
  includeInBudget: boolean;
  includeInNetWorth: boolean;
  archived: boolean;
  /** The bank or broker connection that syncs this account, if any. */
  connectionId: string | null;
  /** Credit limit of a card, minor units; null when unset. */
  creditLimit: number | null;
  balance?: number;
  /** What a card owes (see `cardOwed`); null for other types. */
  owed?: number | null;
  /** Money not invested, and the invested part (`cash + invested === balance`). */
  cash?: number;
  invested?: number;
}

export function toAccountDto(a: Account | AccountWithBalance): AccountDto {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    institutionName: a.institutionName,
    ibanLast4: a.ibanLast4,
    openingBalance: a.openingBalance,
    openingBalanceDate: a.openingBalanceDate,
    includeInBudget: a.includeInBudget,
    includeInNetWorth: a.includeInNetWorth,
    archived: a.archivedAt !== null,
    connectionId: a.connectionId,
    creditLimit: a.creditLimit,
    ...('balance' in a
      ? { balance: a.balance, owed: a.owed, cash: a.cash, invested: a.invested }
      : {}),
  };
}

export interface CategoryDto {
  id: string;
  name: string;
  icon: string | null;
  templateKey: string | null;
  archived: boolean;
  groupId: string;
  groupName: string;
  groupKind: 'income' | 'expense' | 'saving' | 'transfer';
  /** Stable colour slot 1-7 of the group (8 is reserved for uncategorised). */
  slot: number;
}

export interface GroupDto {
  id: string;
  name: string;
  kind: CategoryDto['groupKind'];
  templateKey: string | null;
  archived: boolean;
  slot: number;
  categories: CategoryDto[];
}

const SLOTS = 7;

/** Groups in display order with their categories; colour slots follow the order of all groups. */
export function toGroupDtos(groups: CategoryGroupWithCategories[]): GroupDto[] {
  return groups.map((g, index) => {
    const slot = (index % SLOTS) + 1;
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      templateKey: g.templateKey,
      archived: g.archivedAt !== null,
      slot,
      categories: g.categories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        templateKey: c.templateKey,
        archived: c.archivedAt !== null || g.archivedAt !== null,
        groupId: g.id,
        groupName: g.name,
        groupKind: g.kind,
        slot,
      })),
    };
  });
}

export interface TxDto {
  id: string;
  accountId: string;
  bookingDate: string;
  /** The day the money was spent (purchase date, else booking date): lists group and sort by it. */
  purchaseDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'booked';
  rawDescription: string;
  counterparty: string | null;
  categoryId: string | null;
  categorisedBy: 'rule' | 'memory' | 'ai' | 'user' | null;
  confidence: number | null;
  /** The model's category suggestion (the row stays uncategorised in review). */
  aiSuggestedCategoryId: string | null;
  /** Set once the AI judged the row: the confidence of the applied or suggested category. */
  aiConfidence: number | null;
  needsReview: boolean;
  transferGroupId: string | null;
  notes: string | null;
  source: 'connector' | 'import' | 'manual';
  importBatchId: string | null;
  editedAt: string | null;
  /** Purchase date as the bank reports it (`YYYY-MM-DD`), when it differs from the booking. */
  transactionDate: string | null;
  /** Exact purchase instant (ISO), when the provider gives one. */
  occurredAt: string | null;
  /** ISO 18245 merchant category code. */
  mcc: string | null;
  /** The linked merchant (friendly name, website, `hasLogo` for `/api/merchants/<id>/logo`). */
  merchant: TransactionMerchant | null;
  /** City and country of the transaction, when known. */
  location: TransactionLocation | null;
}

/** A row as the write operations return it: the columns, without the merchant fields. */
export type TxSource = Omit<TransactionListRow, 'merchant' | 'location'>;

export function toTxDto(t: TransactionListRow): TxDto {
  return {
    transactionDate: t.transactionDate,
    occurredAt: t.occurredAt ? t.occurredAt.toISOString() : null,
    mcc: t.mcc,
    id: t.id,
    accountId: t.accountId,
    bookingDate: t.bookingDate,
    purchaseDate: t.purchaseDate,
    valueDate: t.valueDate,
    amount: t.amount,
    currency: t.currency,
    status: t.status,
    rawDescription: t.rawDescription,
    counterparty: t.counterparty,
    categoryId: t.categoryId,
    categorisedBy: t.categorisedBy,
    confidence: t.confidence,
    aiSuggestedCategoryId: t.aiSuggestedCategoryId,
    aiConfidence: t.aiConfidence,
    needsReview: t.needsReview,
    transferGroupId: t.transferGroupId,
    notes: t.notes,
    source: t.source,
    importBatchId: t.importBatchId,
    editedAt: t.userEditedAt ? t.userEditedAt.toISOString() : null,
    merchant: t.merchant,
    location: t.location,
  };
}

export interface RuleDto {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  condition: RuleRow['condition'];
  categoryId: string;
}

export function toRuleDto(r: RuleRow): RuleDto {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    condition: r.condition,
    categoryId: r.categoryId,
  };
}

/** What the connection screens render: ISO strings only, never provider messages or secrets. */
export interface ConnectionDto {
  id: string;
  provider: ConnectionSummary['provider'];
  displayName: string;
  institutionName: string | null;
  status: ConnectionSummary['status'];
  consentExpiresAt: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  manualRefresh: ConnectionSummary['manualRefresh'];
  accounts: Array<{ accountId: string; name: string }>;
}

/**
 * `lastErrorMessage` is deliberately dropped: it is English and the UI explains the error code
 * in the household's language instead.
 */
export function toConnectionDto(c: ConnectionSummary): ConnectionDto {
  return {
    id: c.id,
    provider: c.provider,
    displayName: c.displayName,
    institutionName: c.institutionName,
    status: c.status,
    consentExpiresAt: c.consentExpiresAt ? c.consentExpiresAt.toISOString() : null,
    lastSuccessAt: c.lastSuccessAt ? c.lastSuccessAt.toISOString() : null,
    nextSyncAt: c.nextSyncAt ? c.nextSyncAt.toISOString() : null,
    consecutiveFailures: c.consecutiveFailures,
    lastErrorCode: c.lastErrorCode,
    manualRefresh: c.manualRefresh,
    accounts: c.accounts.map((a) => ({ accountId: a.accountId, name: a.name })),
  };
}
