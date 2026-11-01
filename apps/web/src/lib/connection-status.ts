import { dayDifference, todayIn } from './dates';
import type { ConnectionDto } from '@/server/serialize';

/** Consent horizon after which the UI warns (matches the service's CONSENT_WARNING_DAYS). */
export const EXPIRY_WARNING_DAYS = 7;
const STALE_HOURS = 36;
const HOUR_MS = 3_600_000;

export type StatusKey =
  | 'syncing'
  | 'expired'
  | 'needsRenewal'
  | 'revoked'
  | 'pending'
  | 'failing'
  | 'expiring'
  | 'neverSynced'
  | 'stale'
  | 'ok';
export type StatusTone = 'muted' | 'negative' | 'warning' | 'positive';
export type StatusIcon = 'spinner' | 'x-circle' | 'dashed' | 'alert' | 'clock' | 'check';

export interface ConnectionStatus {
  key: StatusKey;
  tone: StatusTone;
  icon: StatusIcon;
  /** Calendar days to the end of access (expiring) or days without data (stale). */
  days?: number;
}

/** Whole calendar days from today to `iso` in the household time zone (negative once past). */
export function calendarDaysUntil(iso: string, now: Date, timeZone: string): number {
  return dayDifference(todayIn(timeZone, new Date(iso)), todayIn(timeZone, now));
}

/** First match wins, in the order of the UX brief (section 1.3). */
export function connectionStatus(
  c: Pick<
    ConnectionDto,
    | 'status'
    | 'lastErrorCode'
    | 'consecutiveFailures'
    | 'consentExpiresAt'
    | 'lastSuccessAt'
    | 'provider'
  >,
  now: Date,
  timeZone: string,
  syncing = false,
): ConnectionStatus {
  if (syncing) return { key: 'syncing', tone: 'muted', icon: 'spinner' };
  const expiryDays =
    c.provider === 'enablebanking' && c.consentExpiresAt
      ? calendarDaysUntil(c.consentExpiresAt, now, timeZone)
      : null;
  if (c.status === 'expired' || (c.status === 'active' && expiryDays !== null && expiryDays < 0)) {
    return { key: 'expired', tone: 'negative', icon: 'x-circle' };
  }
  if (c.status === 'error' || c.lastErrorCode === 'auth') {
    return { key: 'needsRenewal', tone: 'negative', icon: 'x-circle' };
  }
  if (c.status === 'revoked') return { key: 'revoked', tone: 'negative', icon: 'x-circle' };
  if (c.status === 'pending') return { key: 'pending', tone: 'warning', icon: 'dashed' };
  if (c.consecutiveFailures > 0) return { key: 'failing', tone: 'warning', icon: 'alert' };
  if (expiryDays !== null && expiryDays <= EXPIRY_WARNING_DAYS) {
    return { key: 'expiring', tone: 'warning', icon: 'alert', days: expiryDays };
  }
  if (!c.lastSuccessAt) return { key: 'neverSynced', tone: 'muted', icon: 'clock' };
  const age = now.getTime() - new Date(c.lastSuccessAt).getTime();
  if (age > STALE_HOURS * HOUR_MS) {
    return {
      key: 'stale',
      tone: 'warning',
      icon: 'clock',
      days: Math.max(1, Math.floor(age / (24 * HOUR_MS))),
    };
  }
  return { key: 'ok', tone: 'positive', icon: 'check' };
}

/** Everything but a healthy or merely waiting connection asks the person to do something. */
export function needsAttention(key: StatusKey): boolean {
  return !['ok', 'neverSynced', 'syncing', 'stale'].includes(key);
}

/** Problems that block syncing until access is renewed. */
export function isBlocking(key: StatusKey): boolean {
  return key === 'expired' || key === 'needsRenewal' || key === 'revoked';
}

/** Needs-attention first; the input is already oldest first and the sort is stable. */
export function sortConnections<T>(items: T[], keyOf: (item: T) => StatusKey): T[] {
  return [...items].sort(
    (a, b) => Number(needsAttention(keyOf(b))) - Number(needsAttention(keyOf(a))),
  );
}
