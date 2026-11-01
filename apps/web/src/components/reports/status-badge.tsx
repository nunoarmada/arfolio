import { CircleAlert, CircleMinus, Clock, FileX } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { RowStatus } from '@/lib/reports';
import { StatusChip } from '../ui/badge';

const LOOK = {
  pending: { Icon: Clock, tone: 'neutral' },
  failed: { Icon: CircleAlert, tone: 'negative' },
  skipped: { Icon: CircleMinus, tone: 'neutral' },
  none: { Icon: FileX, tone: 'neutral' },
} as const;

/** The state of a report as icon plus word, never colour alone. A ready report has no badge. */
export async function ReportStatusBadge({
  status,
  className,
}: {
  status: Exclude<RowStatus, 'ready'>;
  className?: string;
}) {
  const t = await getTranslations('reports.status');
  const { Icon, tone } = LOOK[status];
  return (
    <StatusChip
      tone={tone}
      className={className}
      icon={<Icon className="size-3.5 shrink-0" aria-hidden="true" />}
    >
      {t(status)}
    </StatusChip>
  );
}
