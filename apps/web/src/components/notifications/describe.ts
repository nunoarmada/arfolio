import {
  AlertTriangle,
  CalendarX,
  Sparkles,
  TrendingDown,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { notificationPath } from '@arfolio/services/notification-links';
import { calendarDaysUntil } from '@/lib/connection-status';
import { errorShortText, type ConnectionsT } from '@/lib/connection-copy';
import { addMonths, formatDate } from '@/lib/dates';
import { zonedDate } from '@/lib/when';
import type { FormatMoney } from '@/lib/money-privacy';
import type { NotificationDto } from '@/server/notifications-data';

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface Described {
  icon: LucideIcon;
  tone: 'warning' | 'negative' | 'info';
  title: string;
  body: string;
  action: { href: string; label: string };
}

interface Deps {
  t: Translate;
  connections: ConnectionsT;
  locale: string;
  timeZone: string;
  currency: string;
  now: Date;
  /** Masks amounts in privacy mode. */
  formatMoney: FormatMoney;
}

/** "outubro", with the year added only when it is not the current one. */
function monthLabel(start: string, index: number, { locale, timeZone, now }: Deps): string {
  const first = addMonths(start, index - 1);
  const year = Number(first.slice(0, 4));
  const current = Number(
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(now),
  );
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    ...(year === current ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(new Date(`${first}T00:00:00Z`));
}

/** "setembro de 2025" for a report month `yyyy-mm`. */
function reportMonthLabel(month: string, { locale }: Deps): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));
}

/**
 * The title, body and action of a notification, in the household's language. Names come from the
 * current budget, line or recurring item; a target that is gone gets generic copy and a link to
 * the section instead.
 */
export function describeNotification(n: NotificationDto, deps: Deps): Described {
  const { t, locale, timeZone, now } = deps;
  const money = (minor: number, currency: string | null = null) =>
    deps.formatMoney(minor, currency ?? deps.currency, locale);

  switch (n.kind) {
    case 'budget_line_threshold': {
      const month = n.budgetStart ? monthLabel(n.budgetStart, n.monthIndex, deps) : null;
      const line = n.lineName ? t('quoted', { name: n.lineName }) : t('fallbackLine');
      const over = n.threshold >= 100;
      const values = { line, threshold: n.threshold, month: month ?? '' };
      const href = notificationPath(n.kind, n);
      return {
        icon: over ? XCircle : AlertTriangle,
        tone: over ? 'negative' : 'warning',
        title: t(`${over ? 'thresholdOver' : 'thresholdWarn'}${month ? '' : 'NoMonth'}`, values),
        body: over
          ? t('thresholdOverBody', {
              over: money(Math.max(0, n.actual - n.planned)),
              actual: money(n.actual),
              planned: money(n.planned),
            })
          : t('thresholdWarnBody', { actual: money(n.actual), planned: money(n.planned) }),
        action: { href, label: n.lineId ? t('viewLine') : t('viewBudget') },
      };
    }
    case 'budget_unallocated_negative': {
      const month = n.budgetStart ? monthLabel(n.budgetStart, n.monthIndex, deps) : null;
      return {
        icon: XCircle,
        tone: 'negative',
        title: month ? t('unallocated', { month }) : t('unallocatedNoMonth'),
        body: t('unallocatedBody', { amount: money(Math.abs(n.remainingInHub)) }),
        action: {
          href: notificationPath(n.kind, n),
          label: n.budgetStart ? t('viewPlan') : t('viewBudget'),
        },
      };
    }
    case 'recurring_missed': {
      return {
        icon: CalendarX,
        tone: 'warning',
        title: n.name ? t('recurringMissed', { name: n.name }) : t('recurringMissedGeneric'),
        body: n.expectedOn
          ? t('recurringMissedBody', {
              date: formatDate(n.expectedOn, locale),
              amount: money(Math.abs(n.amount), n.currency),
            })
          : t('recurringMissedBodyNoDate'),
        action: {
          href: notificationPath(n.kind, n),
          label: t('viewSubscriptions'),
        },
      };
    }
    case 'recurring_price_change': {
      const cheaper = Math.abs(n.amount) < Math.abs(n.previousAmount);
      return {
        icon: cheaper ? TrendingDown : TrendingUp,
        tone: 'warning',
        title: n.name ? t('priceChange', { name: n.name }) : t('priceChangeGeneric'),
        body: n.date
          ? t('priceChangeBody', {
              previous: money(Math.abs(n.previousAmount), n.currency),
              amount: money(Math.abs(n.amount), n.currency),
              date: formatDate(n.date, locale),
            })
          : t('priceChangeBodyNoDate', {
              previous: money(Math.abs(n.previousAmount), n.currency),
              amount: money(Math.abs(n.amount), n.currency),
            }),
        action: {
          href: notificationPath(n.kind, n),
          label: n.recurringId ? t('updateAmount') : t('viewSubscriptions'),
        },
      };
    }
    case 'ai_report_ready': {
      const month = n.month ? reportMonthLabel(n.month, deps) : null;
      return {
        icon: Sparkles,
        tone: 'info',
        title: month ? t('aiReportReady', { month }) : t('aiReportReadyNoMonth'),
        body: t('aiReportReadyBody'),
        action: {
          href: notificationPath(n.kind, { reportMonth: n.month }),
          label: t('viewReport'),
        },
      };
    }
    default: {
      const name = n.name ?? t('unknownConnection');
      // The path comes from the shared function; only the bank renew link is the web's own.
      const viewHref = notificationPath(n.kind, { connectionId: n.connection?.id });
      const view = {
        href: viewHref,
        label: n.connection ? t('viewConnection') : t('viewConnections'),
      };
      const renewAction =
        n.connection?.provider === 'enablebanking'
          ? {
              href: `/connections/new/bank/authorise?connection=${n.connection.id}`,
              label: t('renew'),
            }
          : view;
      if (n.kind === 'consent_expiring') {
        const days = n.expiresAt ? Math.max(0, calendarDaysUntil(n.expiresAt, now, timeZone)) : 0;
        return {
          icon: AlertTriangle,
          tone: 'warning',
          title: t('consentExpiring', { name, days }),
          body: n.expiresAt
            ? t('consentExpiringBody', { date: zonedDate(n.expiresAt, locale, timeZone) })
            : t('consentExpiringBodyNoDate'),
          action: renewAction,
        };
      }
      if (n.kind === 'consent_expired') {
        return {
          icon: XCircle,
          tone: 'negative',
          title: t('consentExpired', { name }),
          body: t('consentExpiredBody'),
          action: renewAction,
        };
      }
      return {
        icon: XCircle,
        tone: 'negative',
        title: t('syncFailing', { name }),
        body: t('syncFailingBody', {
          count: n.failures ?? 1,
          reason: errorShortText(
            deps.connections,
            n.errorCode,
            n.connection?.provider ?? 'enablebanking',
          ),
        }),
        action: view,
      };
    }
  }
}
