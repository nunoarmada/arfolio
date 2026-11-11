import type { SyncAllResult } from '@arfolio/services';

/** A translator scoped to the `syncAll` namespace. */
export type SyncAllT = (key: string, values?: Record<string, string | number>) => string;

export interface SyncAllMessage {
  tone: 'success' | 'warning' | 'info';
  message: string;
}

/**
 * One toast for the whole "Sync all" run: the new movements first, then whatever did not go
 * through (failed, already running, over the manual allowance). `when` formats `retryAt`.
 */
export function syncAllMessage(
  t: SyncAllT,
  r: SyncAllResult,
  when: (iso: string) => string,
): SyncAllMessage {
  if (r.total === 0) return { tone: 'info', message: t('none') };
  const parts: string[] = [];
  if (r.synced > 0) parts.push(t('done', { count: r.inserted }));
  if (r.failed > 0) parts.push(t('failed', { count: r.failed }));
  if (r.busy > 0) parts.push(t('busy', { count: r.busy }));
  if (r.limited > 0 && r.retryAt) {
    parts.push(t('limited', { count: r.limited, when: when(r.retryAt) }));
  }
  const tone =
    r.failed > 0 || (r.synced > 0 && r.synced < r.total)
      ? 'warning'
      : r.synced > 0
        ? 'success'
        : 'info';
  return { tone, message: parts.join(' ') };
}
