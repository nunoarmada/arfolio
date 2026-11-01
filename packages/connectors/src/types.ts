import type { TransactionDetails } from '@arfolio/core';

/** One account exposed by a provider. `externalUid` is session-scoped; `externalKey` is stable. */
export type ExternalAccount = {
  externalUid: string;
  externalKey: string;
  name: string;
  currency: string;
  iban?: string;
  /**
   * False when `externalKey` is only the session-scoped uid (no IBAN and no identification
   * hash): a re-consent yields new uids, so the sync engine must not relink accounts on it.
   * Omitted (stable) for every other account.
   */
  stableKey?: false;
};

/**
 * Structurally identical to `IngestRow` in `@arfolio/services` (re-declared here so this package
 * does not depend on it). `amount` is signed integer minor units.
 */
export type ProviderTx = {
  externalId?: string;
  bookingDate: string;
  valueDate?: string;
  amount: number;
  currency: string;
  description: string;
  counterparty?: string;
  status: 'booked' | 'pending';
  /** The day the purchase or operation happened (distinct from booking and value date). */
  transactionDate?: string;
  /** Exact instant (ISO 8601 UTC) when the provider gives one. */
  occurredAt?: string;
  /** ISO 18245 merchant category code (four digits). */
  mcc?: string;
  details?: TransactionDetails;
};

export type ProviderBalance = {
  externalUid: string;
  asOf: string;
  /** Signed integer minor units. */
  amount: number;
  currency: string;
  kind: string;
};

/** Consent expired or credentials invalid/revoked: the connection must be re-authorised. */
export class ProviderAuthError extends Error {
  constructor(message = 'Provider rejected the credentials') {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds?: number,
    message = 'Provider rate limit exceeded',
  ) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

/** 5xx responses, timeouts and network failures. */
export class ProviderUnavailableError extends Error {
  constructor(message = 'Provider unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The provider answered, but not with the shape we expect. */
export class ProviderResponseError extends Error {
  constructor(
    message = 'Unexpected provider response',
    /** HTTP status when the error comes from a rejected request. */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}
