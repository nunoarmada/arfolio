'use client';

import { ChartLine, RefreshCw, Table2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { formatList, formatMonthTitle } from '@/lib/net-worth-format';
import type { HistoryData, RangeKey } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { SegmentedNav } from '../ui/segmented-nav';
import { HistoryChart } from './history-chart';
import { HistoryTable } from './history-table';
import { RecalculateSheet } from './recalculate-sheet';

const RANGES: RangeKey[] = ['12', '24', 'all'];
const STORAGE_KEY = 'nw-history-view';

/** "Evolução": the range control, the chart or its table, and the recalculate action. */
export function HistorySection({
  history,
  currentMonth,
  range,
  canWrite,
  recalcMonths,
  recalcDefault,
}: {
  history: HistoryData;
  currentMonth: string;
  range: RangeKey;
  canWrite: boolean;
  recalcMonths: string[];
  recalcDefault: string;
}) {
  const t = useTranslations('netWorth');
  const chart = useTranslations('netWorthChart');
  const router = useRouter();
  const { locale } = useHouseholdFormat();
  const titleId = useId();
  const [asTable, setAsTable] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  // The reader's choice of table or chart is remembered on this device only.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === 'table') setAsTable(true);
    } catch {
      // storage unavailable: the chart is the default
    }
  }, []);
  function toggle() {
    const next = !asTable;
    setAsTable(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'table' : 'chart');
    } catch {
      // not remembered, still works for this visit
    }
  }

  const gaps = history.kind === 'ready' ? history.gaps : [];
  const gapText =
    gaps.length === 0
      ? null
      : gaps.length <= 3
        ? t('gaps', {
            months: formatList(
              gaps.map((m) => formatMonthTitle(m, locale).toLocaleLowerCase(locale)),
              locale,
            ),
          })
        : t('gapsMany', { count: gaps.length });

  return (
    <Card as="section" aria-labelledby={titleId} className="flex h-full flex-col gap-3">
      <CardHeader
        title={t('history')}
        titleId={titleId}
        className="mb-0 md:mb-0"
        actions={
          <SegmentedNav
            label={t('range.label')}
            items={RANGES.map((key) => ({
              href: `/net-worth?range=${key}`,
              label: t(`range.${key}`),
              active: key === range,
            }))}
          />
        }
      />

      {history.kind === 'error' ? (
        <Alert
          tone="error"
          action={
            <Button variant="outline" onClick={() => router.refresh()}>
              {t('retry')}
            </Button>
          }
        >
          {t('historyError')}
        </Alert>
      ) : asTable ? (
        <HistoryTable rows={history.rows} scale={history.scale} currentMonth={currentMonth} />
      ) : (
        <HistoryChart rows={history.rows} scale={history.scale} currentMonth={currentMonth} />
      )}

      {gapText ? <p className="text-sm text-muted-foreground">{gapText}</p> : null}
      {history.kind === 'ready' ? (
        <div className="-ml-3 mt-auto flex flex-wrap items-center gap-x-1">
          <Button variant="ghost" size="sm" onClick={toggle}>
            {asTable ? (
              <ChartLine className="size-4" aria-hidden="true" />
            ) : (
              <Table2 className="size-4" aria-hidden="true" />
            )}
            {asTable ? chart('showChart') : chart('showTable')}
          </Button>
          {canWrite ? (
            <Button variant="ghost" size="sm" onClick={() => setRecalculating(true)}>
              <RefreshCw className="size-4" aria-hidden="true" />
              {t('recalculate')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {canWrite ? (
        <RecalculateSheet
          open={recalculating}
          onOpenChange={setRecalculating}
          months={recalcMonths}
          defaultMonth={recalcDefault}
        />
      ) : null}
    </Card>
  );
}
