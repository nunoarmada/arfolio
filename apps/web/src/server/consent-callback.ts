import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '@arfolio/connectors';
import {
  BankingNotConfiguredError,
  completeBankConsent,
  ConflictError,
  ConsentStateError,
  ForbiddenError,
  listConnections,
  NotFoundError,
  type ConnectorDeps,
  type ServiceCtx,
} from '@arfolio/services';

/** The only values `/connections?result=` accepts: fixed codes, never provider text. */
export const RESULT_CODES = [
  'linked',
  'renewed',
  'cancelled',
  'state_expired',
  'state_used',
  'state_invalid',
  'provider_error',
  'connection_gone',
  'not_configured',
  'misconfigured',
  'sync_in_progress',
  'key_updated',
  'accounts_updated',
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export const isResultCode = (value: unknown): value is ResultCode =>
  typeof value === 'string' && (RESULT_CODES as readonly string[]).includes(value);

const STATE = /^[A-Za-z0-9_-]{1,512}$/;
const CODE = /^[A-Za-z0-9._~+/=:-]{1,2048}$/;

export interface CallbackParams {
  state: string | null;
  code: string | null;
  /** Any `error` parameter means the person cancelled or the bank refused: its text is ignored. */
  denied: boolean;
}

/** Reads only what the flow needs, and only well-formed values (length and charset). */
export function parseCallbackParams(search: URLSearchParams): CallbackParams {
  const state = search.get('state');
  const code = search.get('code');
  return {
    state: state !== null && STATE.test(state) ? state : null,
    code: code !== null && CODE.test(code) ? code : null,
    denied: search.has('error'),
  };
}

/** Maps what went wrong to a fixed result code. State problems never say which check failed. */
export function resultForError(error: unknown): ResultCode {
  if (error instanceof ConsentStateError) {
    if (error.reason === 'expired') return 'state_expired';
    if (error.reason === 'used') return 'state_used';
    return 'state_invalid';
  }
  if (error instanceof NotFoundError) return 'connection_gone';
  // A sync of the renewed connection is running: nothing was used up, the person can retry.
  if (error instanceof ConflictError && error.code === 'sync_in_progress') {
    return 'sync_in_progress';
  }
  if (error instanceof BankingNotConfiguredError) return 'not_configured';
  if (error instanceof ForbiddenError) return 'state_invalid';
  // The bank refused our own credentials: an owner has to look at the Enable Banking app.
  if (error instanceof ProviderAuthError) return 'misconfigured';
  if (
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderResponseError ||
    error instanceof ProviderUnavailableError
  ) {
    return 'provider_error';
  }
  return 'provider_error';
}

/**
 * Finishes the consent and returns the in-app path to send the person to. A new connection goes
 * to the link step; a renewal goes back to the list, or to the link step when the bank could not
 * identify some previously linked account.
 */
export async function finishConsent(
  ctx: ServiceCtx,
  deps: ConnectorDeps,
  params: CallbackParams,
): Promise<string> {
  if (params.denied) return '/connections?result=cancelled';
  if (params.state === null || params.code === null) return '/connections?result=state_invalid';
  try {
    const before = await listConnections(ctx);
    const { connectionId } = await completeBankConsent(ctx, deps, {
      state: params.state,
      code: params.code,
    });
    const previous = before.find((c) => c.id === connectionId);
    if (!previous) return `/connections/${connectionId}/link?from=consent`;
    const now = (await listConnections(ctx)).find((c) => c.id === connectionId);
    const lost = previous.accounts.length - (now?.accounts.length ?? 0);
    if (now?.status === 'active' && lost <= 0) {
      return `/connections?result=renewed&id=${connectionId}`;
    }
    return `/connections/${connectionId}/link?from=renewal`;
  } catch (error) {
    const code = resultForError(error);
    if (code === 'provider_error') {
      console.error(`bank consent failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    return `/connections?result=${code}`;
  }
}
