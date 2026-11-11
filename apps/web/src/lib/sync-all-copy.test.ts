import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { syncAllMessage, type SyncAllT } from './sync-all-copy';

const t = createTranslator({ locale: 'en', messages, namespace: 'syncAll' }) as unknown as SyncAllT;
const base = { total: 2, synced: 2, inserted: 0, failed: 0, busy: 0, limited: 0, retryAt: null };
const when = () => 'tomorrow at 06:00';

describe('syncAllMessage', () => {
  it('says how many new movements arrived when everything synced', () => {
    expect(syncAllMessage(t, { ...base, inserted: 3 }, when)).toEqual({
      tone: 'success',
      message: 'Synced · 3 new movements.',
    });
    expect(syncAllMessage(t, base, when).message).toBe('Synced · no new movements.');
  });

  it('warns about failures, busy and limited connections in one message', () => {
    const out = syncAllMessage(
      t,
      { ...base, total: 4, synced: 1, inserted: 1, failed: 1, busy: 1, limited: 1, retryAt: 'x' },
      when,
    );
    expect(out.tone).toBe('warning');
    expect(out.message).toBe(
      'Synced · 1 new movement. 1 connection could not sync; see Connections. 1 connection was already syncing. 1 connection reached the manual refresh limit; try again tomorrow at 06:00.',
    );
  });

  it('is informative when nothing was attempted or everything was limited', () => {
    expect(syncAllMessage(t, { ...base, total: 0, synced: 0 }, when)).toEqual({
      tone: 'info',
      message: 'No active connections to sync.',
    });
    expect(syncAllMessage(t, { ...base, synced: 0, limited: 2, retryAt: 'x' }, when)).toEqual({
      tone: 'info',
      message: '2 connections reached the manual refresh limit; try again tomorrow at 06:00.',
    });
  });
});
