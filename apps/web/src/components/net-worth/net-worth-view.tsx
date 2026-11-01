'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { NetWorthPageData } from '@/server/net-worth-data';
import { cn } from '@/lib/cn';
import { Alert } from '../ui/alert';
import { buttonVariants } from '../ui/button';
import { ExitedList } from './exited-list';
import { HistorySection } from './history-section';
import { ItemGroupList } from './item-group-list';
import { NetWorthHeadline } from './net-worth-headline';

/** The Resumo page body: headline and history side by side from lg, then Ativos and Passivos. */
export function NetWorthView({
  data,
  canWrite,
}: {
  data: Extract<NetWorthPageData, { kind: 'ready' }>;
  canWrite: boolean;
}) {
  const t = useTranslations('netWorth');
  // The nested credits under an asset are the very rows of the Passivos list, found by id.
  const credits = new Map(data.groups.liabilities.flatMap((g) => g.rows).map((r) => [r.refId, r]));
  return (
    <div className="grid grid-cols-1 gap-4 xl:gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-start xl:gap-6">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-4">
          <NetWorthHeadline
            net={data.net}
            assets={data.assets}
            liabilities={data.liabilities}
            change={data.change}
            today={data.today}
            currentMonth={data.currentMonth}
            rows={data.history.kind === 'ready' ? data.history.rows : null}
          />
          {data.foreignCount > 0 ? (
            <Alert tone="info">{t('foreignNotice', { count: data.foreignCount })}</Alert>
          ) : null}
        </div>
        <div className="min-w-0 lg:col-span-8">
          <HistorySection
            history={data.history}
            currentMonth={data.currentMonth}
            range={data.range}
            canWrite={canWrite}
            recalcMonths={data.recalcMonths}
            recalcDefault={data.recalcDefault}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start lg:gap-4 xl:gap-6">
        <ItemGroupList
          side="asset"
          total={data.assets}
          groups={data.groups.assets}
          canWrite={canWrite}
          credits={credits}
        />
        <ItemGroupList
          side="liability"
          total={data.liabilities}
          groups={data.groups.liabilities}
          canWrite={canWrite}
        />
      </div>
      <ExitedList items={data.exited} />
      {canWrite ? (
        <p>
          <Link href="/import/budget" className={cn(buttonVariants({ variant: 'link' }), 'px-0')}>
            {t('importSheet')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
