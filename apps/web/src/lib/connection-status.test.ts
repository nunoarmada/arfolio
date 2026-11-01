import { describe, expect, it } from 'vitest';
import { connectionStatus, needsAttention, sortConnections } from './connection-status';

type Input = Parameters<typeof connectionStatus>[0];

const NOW = new Date('2026-10-18T12:00:00Z');
const base: Input = {
  provider: 'enablebanking',
  status: 'active',
  lastErrorCode: null,
  consecutiveFailures: 0,
  consentExpiresAt: '2027-01-14T00:00:00Z',
  lastSuccessAt: '2026-10-18T10:00:00Z',
};
const status = (patch: Partial<Input>, syncing = false) =>
  connectionStatus({ ...base, ...patch }, NOW, 'Europe/Lisbon', syncing).key;

describe('connectionStatus precedence', () => {
  it('follows the brief: syncing, expired, auth, revoked, pending, failing, expiring, never, stale, ok', () => {
    expect(status({}, true)).toBe('syncing');
    expect(status({ status: 'expired' })).toBe('expired');
    expect(status({ consentExpiresAt: '2026-10-01T00:00:00Z' })).toBe('expired');
    expect(status({ status: 'error' })).toBe('needsRenewal');
    expect(status({ lastErrorCode: 'auth' })).toBe('needsRenewal');
    expect(status({ status: 'revoked' })).toBe('revoked');
    expect(status({ status: 'pending' })).toBe('pending');
    expect(status({ consecutiveFailures: 2 })).toBe('failing');
    expect(status({ consentExpiresAt: '2026-10-23T12:00:00Z' })).toBe('expiring');
    expect(status({ lastSuccessAt: null })).toBe('neverSynced');
    expect(status({ lastSuccessAt: '2026-10-16T12:00:00Z' })).toBe('stale');
    expect(status({})).toBe('ok');
  });

  it('counts calendar days in the household time zone and warns from 7 days', () => {
    const at = (iso: string) =>
      connectionStatus({ ...base, consentExpiresAt: iso }, NOW, 'Europe/Lisbon');
    expect(at('2026-10-25T12:00:00Z')).toMatchObject({ key: 'expiring', days: 7 });
    expect(at('2026-10-26T12:00:00Z').key).toBe('ok');
    expect(at('2026-10-18T22:00:00Z')).toMatchObject({ key: 'expiring', days: 0 });
    expect(at('2026-10-19T08:00:00Z')).toMatchObject({ key: 'expiring', days: 1 });
  });

  it('ignores the consent date for Trading 212 (API keys do not expire)', () => {
    expect(
      connectionStatus(
        { ...base, provider: 'trading212', consentExpiresAt: '2020-01-01T00:00:00Z' },
        NOW,
        'UTC',
      ).key,
    ).toBe('ok');
  });

  it('puts connections that need attention first and keeps the rest in order', () => {
    const items = [
      { id: 'a', k: 'ok' as const },
      { id: 'b', k: 'expired' as const },
      { id: 'c', k: 'ok' as const },
      { id: 'd', k: 'pending' as const },
    ];
    expect(sortConnections(items, (i) => i.k).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(needsAttention('stale')).toBe(false);
    expect(needsAttention('expiring')).toBe(true);
  });
});
