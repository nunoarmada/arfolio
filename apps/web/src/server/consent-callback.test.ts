import { describe, expect, it } from 'vitest';
import { ProviderAuthError, ProviderUnavailableError } from '@arfolio/connectors';
import {
  BankingNotConfiguredError,
  ConflictError,
  ConsentStateError,
  ForbiddenError,
  NotFoundError,
} from '@arfolio/services';
import { isResultCode, parseCallbackParams, resultForError } from './consent-callback';

const params = (qs: string) => parseCallbackParams(new URLSearchParams(qs));

describe('parseCallbackParams', () => {
  it('accepts a normal state and code', () => {
    const state = 'a'.repeat(43);
    expect(params(`state=${state}&code=abc-DEF_123.x`)).toEqual({
      state,
      code: 'abc-DEF_123.x',
      denied: false,
    });
  });

  it('drops values that are too long or use unexpected characters', () => {
    expect(params(`state=${'a'.repeat(513)}&code=ok`).state).toBeNull();
    expect(params('state=a b&code=ok').state).toBeNull();
    expect(params('state=<script>&code=ok').state).toBeNull();
    expect(params(`state=ok&code=${'c'.repeat(2049)}`).code).toBeNull();
    expect(params('state=ok&code=%0d%0aLocation:x').code).toBeNull();
    expect(params('code=ok').state).toBeNull();
  });

  it('treats any error parameter as a refusal, whatever its text', () => {
    expect(params('error=access_denied&error_description=<b>hi</b>').denied).toBe(true);
    expect(params('state=ok&code=ok').denied).toBe(false);
  });
});

describe('resultForError', () => {
  it('maps each failure to one fixed code from the allowlist', () => {
    const cases: Array<[unknown, string]> = [
      [new ConsentStateError('expired'), 'state_expired'],
      [new ConsentStateError('used'), 'state_used'],
      [new ConsentStateError('unknown'), 'state_invalid'],
      [new ConsentStateError('user_mismatch'), 'state_invalid'],
      [new ForbiddenError(), 'state_invalid'],
      [new NotFoundError('Connection'), 'connection_gone'],
      [new ConflictError('sync_in_progress', 'busy'), 'sync_in_progress'],
      [new BankingNotConfiguredError(), 'not_configured'],
      [new ProviderAuthError('x'), 'misconfigured'],
      [new ProviderUnavailableError('x'), 'provider_error'],
      [new Error('boom'), 'provider_error'],
    ];
    for (const [error, code] of cases) {
      expect(resultForError(error)).toBe(code);
      expect(isResultCode(code)).toBe(true);
    }
  });

  it('does not tell a forged state from another user’s state', () => {
    expect(resultForError(new ConsentStateError('unknown'))).toBe(
      resultForError(new ConsentStateError('user_mismatch')),
    );
  });
});

describe('isResultCode', () => {
  it('rejects anything outside the list', () => {
    expect(isResultCode('state_invalid')).toBe(true);
    expect(isResultCode('<script>')).toBe(false);
    expect(isResultCode(undefined)).toBe(false);
  });
});
