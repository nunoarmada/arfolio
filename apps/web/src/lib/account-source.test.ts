import { describe, expect, it } from 'vitest';
import { accountSource } from './account-source';

describe('accountSource', () => {
  it('reports a bank-linked account as synced, with the last successful sync', () => {
    expect(
      accountSource({
        connectionId: 'c1',
        lastSyncAt: '2026-11-02T08:00:00.000Z',
        lastImportAt: null,
      }),
    ).toEqual({ kind: 'synced', at: '2026-11-02T08:00:00.000Z' });
  });

  it('reports a linked account that never synced as synced without a date', () => {
    expect(accountSource({ connectionId: 'c1', lastSyncAt: null, lastImportAt: null })).toEqual({
      kind: 'synced',
      at: null,
    });
  });

  it('prefers the connection over an older file import', () => {
    expect(
      accountSource({
        connectionId: 'c1',
        lastSyncAt: '2026-11-02T08:00:00.000Z',
        lastImportAt: '2026-10-01T08:00:00.000Z',
      }).kind,
    ).toBe('synced');
  });

  it('reports an unlinked account with an import as imported', () => {
    expect(
      accountSource({
        connectionId: null,
        lastSyncAt: null,
        lastImportAt: '2026-11-02T08:00:00.000Z',
      }),
    ).toEqual({ kind: 'imported', at: '2026-11-02T08:00:00.000Z' });
  });

  it('reports everything else as manual', () => {
    expect(accountSource({ connectionId: null, lastSyncAt: null, lastImportAt: null })).toEqual({
      kind: 'manual',
    });
  });
});
