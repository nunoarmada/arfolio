import type { ConnectionDto } from '@/server/serialize';
import { calendarDaysUntil, type ConnectionStatus, type StatusKey } from './connection-status';
import { dayTime, relativeTime, zonedDate, type WhenLabels } from './when';

/** A translator scoped to the `connections` namespace (client hook or server getTranslations). */
export type ConnectionsT = (key: string, values?: Record<string, string | number>) => string;

export interface CopyContext {
  now: Date;
  locale: string;
  timeZone: string;
}

export const whenLabels = (t: ConnectionsT): WhenLabels => ({
  justNow: t('justNow'),
  todayAt: (time) => t('meta.todayAt', { time }),
  tomorrowAt: (time) => t('meta.tomorrowAt', { time }),
  dateAt: (date, time) => t('meta.dateAt', { date, time }),
});

/** Like `whenLabels`, but today reads "às 14:05" (for "Próxima atualização manual às 14:05"). */
export const atLabels = (t: ConnectionsT): WhenLabels => ({
  ...whenLabels(t),
  todayAt: (time) => t('meta.atTime', { time }),
});

/** "Sincronizado há 2 h", "Acesso expirado", ... : the status word that sits next to the icon. */
export function statusLabel(
  t: ConnectionsT,
  s: ConnectionStatus,
  lastSuccessAt: string | null,
  cx: CopyContext,
): string {
  switch (s.key) {
    case 'expiring':
      return t('status.expiring', { days: s.days ?? 0 });
    case 'stale':
      return t('status.stale', { days: s.days ?? 1 });
    case 'ok':
      return t('status.ok', {
        when: lastSuccessAt
          ? relativeTime(lastSuccessAt, cx.now, cx.locale, t('justNow'))
          : t('justNow'),
      });
    default:
      return t(`status.${s.key}`);
  }
}

/** The short word the Home strip shows next to a connection's name when something is wrong. */
export function stripLabel(
  t: ConnectionsT,
  key: StatusKey,
  lastSuccessAt: string | null,
  cx: CopyContext,
): string {
  if (key === 'ok') {
    return lastSuccessAt
      ? relativeTime(lastSuccessAt, cx.now, cx.locale, t('justNow'))
      : t('justNow');
  }
  if (key === 'syncing') return t('status.syncing');
  return t(`stripShort.${key}`);
}

const KNOWN_ERRORS = new Set([
  'auth',
  'consent_expired',
  'rate_limited',
  'unavailable',
  'bad_response',
  'rejected',
  'skipped_rows',
  'history_incomplete',
  'decrypt_failed',
]);

/** The explanation for an error code, in the household language. Provider text is never shown. */
export function errorText(
  t: ConnectionsT,
  code: string | null,
  provider: ConnectionDto['provider'],
): string {
  if (code === 'auth' && provider === 'trading212') return t('error.authT212');
  if (code !== null && KNOWN_ERRORS.has(code)) return t(`error.${code}`);
  return t('error.internal');
}

export function lastSyncedLine(
  t: ConnectionsT,
  lastSuccessAt: string | null,
  cx: CopyContext,
): { text: string; title?: string; iso?: string } {
  if (!lastSuccessAt) return { text: t('meta.neverSynced') };
  return {
    text: relativeTime(lastSuccessAt, cx.now, cx.locale, t('justNow')),
    title: new Intl.DateTimeFormat(cx.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: cx.timeZone,
    }).format(new Date(lastSuccessAt)),
    iso: lastSuccessAt,
  };
}

export const nextSyncLine = (t: ConnectionsT, nextSyncAt: string, cx: CopyContext): string =>
  dayTime(nextSyncAt, cx.now, cx.locale, cx.timeZone, whenLabels(t));

export type ConsentLine = { text: string; tone: 'muted' | 'warning' | 'negative' };

/** "Válido até 14 jan. 2027 · faltam 88 dias" and its warning/expired variants (banks only). */
export function consentLine(
  t: ConnectionsT,
  c: Pick<ConnectionDto, 'provider' | 'consentExpiresAt'>,
  cx: CopyContext,
): ConsentLine | null {
  if (c.provider === 'trading212') return { text: t('meta.t212Access'), tone: 'muted' };
  if (!c.consentExpiresAt) return { text: t('meta.expiryUnknown'), tone: 'muted' };
  const days = calendarDaysUntil(c.consentExpiresAt, cx.now, cx.timeZone);
  if (days < 0) {
    return {
      text: t('meta.expiredOn', {
        date: zonedDate(c.consentExpiresAt, cx.locale, cx.timeZone),
      }),
      tone: 'negative',
    };
  }
  if (days <= 7) return { text: t('meta.expiresIn', { days }), tone: 'warning' };
  return {
    text: t('meta.validUntil', {
      date: zonedDate(c.consentExpiresAt, cx.locale, cx.timeZone),
      days,
    }),
    tone: 'muted',
  };
}

/** The line under the sync button: what is left, or when the next manual refresh opens. */
export function manualHelper(
  t: ConnectionsT,
  c: Pick<ConnectionDto, 'manualRefresh'>,
  cx: CopyContext,
): string {
  const m = c.manualRefresh;
  if (m.remaining === 0 && m.retryAt) {
    return t('helper.nextManual', {
      when: dayTime(m.retryAt, cx.now, cx.locale, cx.timeZone, atLabels(t)),
    });
  }
  return m.window === 'day'
    ? t('helper.manualLeft', { count: m.remaining })
    : t('helper.t212Every');
}

const SHORT_ERRORS = new Set([...KNOWN_ERRORS]);

/** A short lower-case reason to follow a colon ("...falharam: o serviço do banco está indisponível"). */
export function errorShortText(
  t: ConnectionsT,
  code: string | null,
  provider: ConnectionDto['provider'],
): string {
  if (code === 'auth' && provider === 'trading212') return t('errorShort.authT212');
  if (code !== null && SHORT_ERRORS.has(code)) return t(`errorShort.${code}`);
  return t('errorShort.internal');
}
