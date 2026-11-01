'use client';

import { ChartColumn, Table2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { dataTable } from '../ui/data-table';
import { ScrollRegion } from '../ui/scroll-region';
import { useInsightsView, type InsightsView } from './use-insights-view';

/**
 * One section of Análises: a card with its heading on the left and the "Ver como tabela / Ver
 * gráfico" button on the right (the same choice for every section). The body is a function of
 * the current view.
 */
export function SectionCard({
  testId,
  title,
  toggle = true,
  className,
  children,
}: {
  testId: string;
  title: string;
  /** Hide the button when there is nothing to switch (an empty section). */
  toggle?: boolean;
  className?: string;
  children: (view: InsightsView, titleId: string) => ReactNode;
}) {
  const t = useTranslations('insights');
  const [view, flip] = useInsightsView();
  const titleId = useId();
  return (
    <Card
      as="section"
      data-testid={testId}
      aria-labelledby={titleId}
      className={cn('@container flex min-w-0 flex-col gap-4', className)}
    >
      <CardHeader
        title={title}
        titleId={titleId}
        className="mb-0 md:mb-0"
        actions={
          toggle ? (
            <Button variant="ghost" size="sm" onClick={flip} className="-my-1 -mr-2 shrink-0 px-2">
              {view === 'table' ? (
                <ChartColumn className="size-4" aria-hidden="true" />
              ) : (
                <Table2 className="size-4" aria-hidden="true" />
              )}
              {view === 'table' ? t('showChart') : t('showTable')}
            </Button>
          ) : undefined
        }
      />
      {children(view, titleId)}
    </Card>
  );
}

/**
 * A table that scrolls sideways inside its own focusable region (never the page), with the first
 * column sticky. The label is the table's caption.
 */
export function TableRegion({
  label,
  testId,
  narrow = false,
  compact = false,
  children,
}: {
  label: string;
  testId?: string;
  /** Three columns or fewer: fit a phone card without scrolling sideways. */
  narrow?: boolean;
  /** Four short columns: fit a narrow desktop card (about 340px) without scrolling. */
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <ScrollRegion
      label={label}
      testId={testId}
      className="rounded-md shadow-none ring-1 ring-border"
    >
      <table
        className={cn(
          'w-full border-collapse text-sm tabular-nums',
          narrow ? 'min-w-[17rem]' : compact ? 'min-w-[20rem]' : 'min-w-[26rem]',
        )}
      >
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </ScrollRegion>
  );
}

const STICKY_EDGE =
  'group-data-[start=false]/scroll:shadow-[1px_0_0_var(--border-strong),6px_0_8px_-6px_var(--edge-shadow)]';
export const TH = cn(dataTable.th, 'text-left');
export const TH_FIRST = cn(TH, dataTable.stickyFirstHead);
export const ROW_HEAD = cn(
  'sticky left-0 z-10 whitespace-nowrap bg-inherit px-3 py-2 text-left text-sm font-normal',
  STICKY_EDGE,
);
