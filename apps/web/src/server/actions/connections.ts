'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '@arfolio/connectors';
import {
  addTrading212Connection,
  BankingNotConfiguredError,
  ForbiddenError,
  linkConnectionAccounts,
  listConnections,
  ManualRefreshLimitError,
  markAllNotificationsRead,
  markNotificationRead,
  listNotifications,
  NotFoundError,
  removeConnection,
  requestManualSync,
  startBankConsent,
  ConflictError,
  ValidationError,
  updateTrading212Credentials,
  type ConnectionLink,
} from '@arfolio/services';
import { getConnectorDeps } from '../connector-deps';
import { psuHeadersFrom } from '../psu-headers';
import { getServiceCtx } from '../service-ctx';
import { ForbiddenError as SessionForbiddenError } from '../session';
import {
  loadNotificationTargets,
  toNotificationDto,
  type NotificationDto,
} from '../notifications-data';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

const isControlFlow = (error: unknown): boolean =>
  typeof (error as { digest?: unknown })?.digest === 'string';

const isForbidden = (error: unknown): boolean =>
  error instanceof ForbiddenError || error instanceof SessionForbiddenError;

/** Last resort for the guarded actions below: log the type only, never provider text. */
function unexpected(error: unknown): { ok: false; error: 'error' } {
  if (isControlFlow(error)) throw error;
  console.error(`connection action failed: ${error instanceof Error ? error.name : 'unknown'}`);
  return { ok: false, error: 'error' };
}

// ---------------------------------------------------------------------------------------------
// Sync now

export type SyncOutcome =
  | { kind: 'synced'; inserted: number; partial: boolean }
  | { kind: 'failed'; errorCode: string | null }
  | { kind: 'locked' }
  | { kind: 'limit'; retryAt: string }
  | { kind: 'not_active' }
  | { kind: 'gone' };

export async function syncNowAction(connectionId: string): Promise<ActionResult<SyncOutcome>> {
  return run(async (): Promise<SyncOutcome> => {
    const requestHeaders = await headers();
    const ctx = await getServiceCtx(requestHeaders);
    try {
      // A person asked for this refresh: let the bank know, so it is not counted as unattended.
      const result = await requestManualSync(ctx, await getConnectorDeps(), connectionId, {
        psuHeaders: psuHeadersFrom(requestHeaders),
      });
      refresh();
      if (result.status === 'skipped') {
        return result.reason === 'locked' ? { kind: 'locked' } : { kind: 'not_active' };
      }
      if (result.status === 'failed') return { kind: 'failed', errorCode: result.errorCode };
      return { kind: 'synced', inserted: result.inserted, partial: result.status === 'partial' };
    } catch (error) {
      if (error instanceof ManualRefreshLimitError) {
        refresh();
        return { kind: 'limit', retryAt: error.retryAt.toISOString() };
      }
      if (error instanceof ValidationError && error.code === 'connection_inactive') {
        return { kind: 'not_active' };
      }
      if (error instanceof NotFoundError) return { kind: 'gone' };
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Remove

export type RemoveOutcome =
  | { kind: 'removed'; providerSessionRevoked: boolean; consentExpiresAt: string | null }
  | { kind: 'busy' }
  | { kind: 'gone' };

export async function removeConnectionAction(
  connectionId: string,
): Promise<ActionResult<RemoveOutcome>> {
  return run(async (): Promise<RemoveOutcome> => {
    const ctx = await getServiceCtx(await headers());
    try {
      const before = (await listConnections(ctx)).find((c) => c.id === connectionId);
      const { providerSessionRevoked } = await removeConnection(
        ctx,
        await getConnectorDeps(),
        connectionId,
      );
      refresh();
      return {
        kind: 'removed',
        providerSessionRevoked,
        consentExpiresAt: before?.consentExpiresAt?.toISOString() ?? null,
      };
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'sync_in_progress') {
        return { kind: 'busy' };
      }
      if (error instanceof NotFoundError) return { kind: 'gone' };
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Bank consent

export type StartConsentResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | 'not_configured'
        | 'misconfigured'
        | 'unknown_bank'
        | 'unreachable'
        | 'gone'
        | 'forbidden'
        | 'error';
    };

/** Returns the bank's authorisation URL; the client navigates there (the state is stored here). */
export async function startBankConsentAction(input: {
  aspspName: string;
  country: string;
  connectionId?: string;
}): Promise<StartConsentResult> {
  try {
    const ctx = await getServiceCtx(await headers());
    const { redirectUrl } = await startBankConsent(ctx, await getConnectorDeps(), input);
    return { ok: true, url: redirectUrl };
  } catch (error) {
    if (error instanceof BankingNotConfiguredError) return { ok: false, error: 'not_configured' };
    if (isForbidden(error)) return { ok: false, error: 'forbidden' };
    if (error instanceof NotFoundError) return { ok: false, error: 'gone' };
    if (error instanceof ValidationError) {
      return { ok: false, error: error.code === 'unknown_bank' ? 'unknown_bank' : 'error' };
    }
    if (error instanceof ProviderUnavailableError || error instanceof ProviderRateLimitError) {
      return { ok: false, error: 'unreachable' };
    }
    // The bank API refused our own credentials: not something the person can fix by retrying.
    if (error instanceof ProviderAuthError) return { ok: false, error: 'misconfigured' };
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Trading 212

export type AddTrading212Result =
  | { ok: true; connectionId: string }
  | {
      ok: false;
      error: 'auth' | 'rate' | 'unavailable' | 'validation' | 'forbidden' | 'error';
      fields?: string[];
    };

/** The key pair is checked against Trading 212 and stored encrypted; it is never returned. */
export async function addTrading212Action(input: {
  apiKey: string;
  apiSecret: string;
  displayName: string;
}): Promise<AddTrading212Result> {
  try {
    const ctx = await getServiceCtx(await headers());
    const { connectionId } = await addTrading212Connection(ctx, await getConnectorDeps(), input);
    refresh();
    return { ok: true, connectionId };
  } catch (error) {
    if (error instanceof ProviderAuthError) return { ok: false, error: 'auth' };
    if (error instanceof ProviderRateLimitError) return { ok: false, error: 'rate' };
    if (error instanceof ProviderUnavailableError) return { ok: false, error: 'unavailable' };
    if (isForbidden(error)) return { ok: false, error: 'forbidden' };
    if (error instanceof ValidationError) {
      const fields = [
        ...new Set(error.issues.map((i) => String(i.path[0] ?? '')).filter((f) => f !== '')),
      ];
      return { ok: false, error: 'validation', fields };
    }
    return unexpected(error);
  }
}

export type UpdateTrading212Result =
  | { ok: true; displayName: string }
  | {
      ok: false;
      error:
        | 'auth'
        | 'rate'
        | 'unavailable'
        | 'different_account'
        | 'busy'
        | 'validation'
        | 'gone'
        | 'forbidden'
        | 'error';
      fields?: string[];
    };

/**
 * Replaces the key pair of an existing Trading 212 connection. The new pair must belong to the
 * account that is already linked; it is stored encrypted and never returned.
 */
export async function updateTrading212Action(input: {
  connectionId: string;
  apiKey: string;
  apiSecret: string;
}): Promise<UpdateTrading212Result> {
  try {
    const ctx = await getServiceCtx(await headers());
    const { connectionId, ...credentials } = input;
    const before = (await listConnections(ctx)).find((c) => c.id === connectionId);
    await updateTrading212Credentials(ctx, await getConnectorDeps(), connectionId, credentials);
    refresh();
    return { ok: true, displayName: before?.displayName ?? '' };
  } catch (error) {
    if (error instanceof ProviderAuthError) return { ok: false, error: 'auth' };
    if (error instanceof ProviderRateLimitError) return { ok: false, error: 'rate' };
    if (error instanceof ProviderUnavailableError) return { ok: false, error: 'unavailable' };
    if (isForbidden(error)) return { ok: false, error: 'forbidden' };
    if (error instanceof NotFoundError) return { ok: false, error: 'gone' };
    if (error instanceof ConflictError && error.code === 'sync_in_progress') {
      return { ok: false, error: 'busy' };
    }
    if (error instanceof ValidationError) {
      if (error.code === 'different_account') return { ok: false, error: 'different_account' };
      if (error.code === 'connection_revoked') return { ok: false, error: 'gone' };
      const fields = [
        ...new Set(error.issues.map((i) => String(i.path[0] ?? '')).filter((f) => f !== '')),
      ];
      return { ok: false, error: 'validation', fields };
    }
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Link accounts

export type LinkAccountsResult =
  | { ok: true; linked: number }
  | {
      ok: false;
      error:
        | 'already_linked'
        | 'currency'
        | 'revoked'
        | 'unknown_account'
        | 'invalid'
        | 'gone'
        | 'forbidden'
        | 'error';
    };

export async function linkAccountsAction(
  connectionId: string,
  links: ConnectionLink[],
): Promise<LinkAccountsResult> {
  try {
    const requestHeaders = await headers();
    const ctx = await getServiceCtx(requestHeaders);
    const { linked } = await linkConnectionAccounts(
      ctx,
      await getConnectorDeps(),
      connectionId,
      links,
      psuHeadersFrom(requestHeaders),
    );
    refresh();
    return { ok: true, linked: linked.length };
  } catch (error) {
    if (isForbidden(error)) return { ok: false, error: 'forbidden' };
    if (error instanceof NotFoundError) return { ok: false, error: 'gone' };
    if (error instanceof ProviderAuthError || error instanceof ProviderUnavailableError) {
      return { ok: false, error: 'unknown_account' };
    }
    if (error instanceof ValidationError) {
      switch (error.code) {
        case 'account_linked_elsewhere':
          return { ok: false, error: 'already_linked' };
        case 'currency_mismatch':
          return { ok: false, error: 'currency' };
        case 'connection_revoked':
          return { ok: false, error: 'revoked' };
        case 'unknown_provider_account':
          return { ok: false, error: 'unknown_account' };
        default:
          return { ok: false, error: 'invalid' };
      }
    }
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Notifications

export interface NotificationPageDto {
  items: NotificationDto[];
  nextCursor: string | null;
}

export async function loadNotificationsAction(
  cursor: string | null,
): Promise<ActionResult<NotificationPageDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const [page, connections] = await Promise.all([
      listNotifications(ctx, cursor ? { cursor } : {}),
      listConnections(ctx),
    ]);
    const known = new Map(connections.map((c) => [c.id, c.provider] as const));
    const targets = await loadNotificationTargets(ctx, page.items);
    return {
      items: page.items.map((n) => toNotificationDto(n, { connections: known, ...targets })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function markNotificationReadAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await markNotificationRead(await getServiceCtx(await headers()), id);
    refresh();
    return null;
  });
}

export async function markAllNotificationsReadAction(): Promise<ActionResult> {
  return run(async () => {
    await markAllNotificationsRead(await getServiceCtx(await headers()));
    refresh();
    return null;
  });
}
