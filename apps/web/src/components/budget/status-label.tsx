'use client';

import { AlertCircle, AlertTriangle, CalendarClock, CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { LineStatus, StatusIcon, StatusTone, SummaryStatus } from '@/lib/budget-status';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { useFormatMoney } from '@/components/privacy';

export const TONE_TEXT: Record<StatusTone, string> = {
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  negative: 'text-negative',
  positive: 'text-positive',
};

const ICONS = {
  triangle: AlertTriangle,
  circle: AlertCircle,
  check: CheckCircle2,
  calendar: CalendarClock,
} as const;

export function StatusGlyph({
  icon,
  className,
}: {
  icon: StatusIcon | 'calendar';
  className?: string;
}) {
  if (icon === 'none') return null;
  const Icon = ICONS[icon];
  return <Icon className={cn('size-4 shrink-0', className)} aria-hidden="true" />;
}

/** "Restam 87,60 €", "Acima 86,50 €", "Recebido": the word that says where a line stands. */
export function StatusLabel({ status, className }: { status: LineStatus; className?: string }) {
  const t = useTranslations('budget.status');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium',
        TONE_TEXT[status.tone],
        className,
      )}
    >
      <StatusGlyph icon={status.icon} />
      <span>
        {t(status.key, { amount: money(status.amount), extra: money(status.extra ?? 0) })}
        {status.extra ? ` ${t('receivedExtra', { extra: money(status.extra) })}` : ''}
      </span>
    </span>
  );
}

/** The month's headline: icon, colour and a sentence. */
export function SummaryHeadline({ status }: { status: SummaryStatus }) {
  const t = useTranslations('budget.summary');
  const statusT = useTranslations('budget.status');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const text = (() => {
    switch (status.key) {
      case 'notStarted':
        return t('notStarted');
      case 'onTrack':
        return t(status.ended ? 'endedOnTrack' : 'onTrack');
      case 'linesOver':
        return t(status.ended ? 'endedLinesOver' : 'linesOver', { count: status.count });
      case 'aheadOfPace':
        return statusT('aheadOfPace');
      case 'nearLimit':
        return statusT('nearLimit');
      case 'overPlan':
        return t(status.ended ? 'endedOverPlan' : 'overPlan', {
          over: formatMoney(status.over, currency, locale),
        });
    }
  })();
  return (
    <p className={cn('flex items-center gap-2 text-base font-semibold', TONE_TEXT[status.tone])}>
      <StatusGlyph icon={status.icon} className="size-5" />
      <span className={status.tone === 'muted' ? '' : 'text-foreground'}>{text}</span>
    </p>
  );
}
