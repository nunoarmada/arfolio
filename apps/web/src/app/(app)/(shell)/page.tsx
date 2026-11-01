import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { BlockSkeleton, KpiSkeleton } from '@/components/home/block-frame';
import {
  AccountsBlock,
  AvailableKpiBlock,
  BudgetBlock,
  ConnectionBannerBlock,
  NetWorthBlock,
  NetWorthKpiBlock,
  SavingsKpiBlock,
  SpendKpiBlock,
  TodoBlock,
  UpcomingBlock,
} from '@/components/home/home-blocks';
import { KpiGrid } from '@/components/home/kpi-tiles';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { monthStart, todayIn } from '@/lib/dates';
import { isHomeEmpty } from '@/lib/home-empty';
import { loadHomeBudget } from '@/server/budget-data';
import {
  loadHomeAccounts,
  loadHomeConnections,
  loadHomeMonthSpend,
  loadHomeReview,
  loadHomeUpcoming,
} from '@/server/home-data';
import { loadHouseholdFormat } from '@/server/household-format';
import { loadHomeNetWorth } from '@/server/net-worth-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('home'))('title') };
}

/**
 * The home dashboard: how the month is going first, then what needs doing, then the slower
 * numbers. Every block loads in its own Suspense boundary and fails on its own; only the check
 * for "no accounts at all" comes first, because it replaces the whole page.
 */
export default async function HomePage() {
  const [session, t, common] = await Promise.all([
    requireMember(await headers()),
    getTranslations('home'),
    getTranslations('common'),
  ]);
  const ctx = toServiceCtx(session);
  const canWrite = session.role !== 'viewer';
  const format = await loadHouseholdFormat(ctx);
  const today = todayIn(format.timeZone);
  const now = new Date();

  // Everything starts together (the loaders never reject); the account list gates the page and
  // feeds the accounts block, so one query serves both. On the no-accounts path the rest is
  // wasted work, a few cheap queries for a household that has just been created.
  // This month's spending is only needed without a budget, by the budget card and two KPI tiles:
  // start it on first use and share the one query.
  let spend: ReturnType<typeof loadHomeMonthSpend> | undefined;
  const monthSpend = () => (spend ??= loadHomeMonthSpend(ctx));
  const accountsLoad = loadHomeAccounts(ctx);
  const connections = loadHomeConnections(ctx, now);
  const budget = loadHomeBudget(ctx);
  const review = loadHomeReview(ctx);
  const upcoming = loadHomeUpcoming(ctx);
  const netWorth = loadHomeNetWorth(ctx);
  const accounts = await accountsLoad;
  // Only a household without accounts waits for net worth, to see whether it tracks assets.
  if (accounts.kind === 'ready' && accounts.count === 0 && isHomeEmpty(accounts, await netWorth)) {
    return (
      <PageContainer>
        <PageHeader title={t('title')} />
        <EmptyState
          title={t('emptyTitle')}
          action={
            canWrite ? (
              <div className="flex flex-wrap gap-3">
                <Link href="/accounts?new=1" className={buttonVariants({})}>
                  {t('addAccount')}
                </Link>
                <Link href="/import" className={buttonVariants({ variant: 'outline' })}>
                  {t('importCsv')}
                </Link>
              </div>
            ) : undefined
          }
        >
          {t('emptyBody')}
        </EmptyState>
      </PageContainer>
    );
  }

  const kpi = await getTranslations('home.kpi');
  const longDate = new Intl.DateTimeFormat(format.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: format.timeZone,
  }).format(now);

  // Grid cells: 12 columns from lg. DOM order is the reading order on phones and tablets (budget,
  // to do, payments, net worth, accounts). From lg the budget spans two rows beside the to-do and
  // payments stack (7/5, 8/4 from xl), then net worth and accounts run full width. A cell whose
  // block renders nothing collapses (`empty:hidden`).
  const cell = 'min-w-0 empty:hidden *:h-full';
  return (
    <PageContainer className="grid grid-cols-1 gap-4 xl:gap-6 [&>header]:mb-0">
      <PageHeader title={t('title')} description={longDate} />

      <Suspense fallback={null}>
        <ConnectionBannerBlock connections={connections} now={now} timeZone={format.timeZone} />
      </Suspense>

      <KpiGrid label={kpi('label')}>
        <Suspense fallback={<KpiSkeleton status={common('loading')} />}>
          <AvailableKpiBlock accounts={accounts} />
        </Suspense>
        <Suspense fallback={<KpiSkeleton />}>
          <SpendKpiBlock budget={budget} monthSpend={monthSpend} />
        </Suspense>
        <Suspense fallback={<KpiSkeleton />}>
          <SavingsKpiBlock budget={budget} monthSpend={monthSpend} />
        </Suspense>
        <Suspense fallback={<KpiSkeleton />}>
          <NetWorthKpiBlock netWorth={netWorth} currentMonth={monthStart(today)} />
        </Suspense>
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 xl:gap-6">
        <div
          className={cn(
            cell,
            'lg:col-span-7 lg:col-start-1 lg:row-span-2 lg:row-start-1 xl:col-span-8',
          )}
        >
          <Suspense fallback={<BlockSkeleton className="min-h-[300px]" />}>
            <BudgetBlock
              budget={budget}
              monthSpend={monthSpend}
              today={today}
              canWrite={canWrite}
            />
          </Suspense>
        </div>
        <div className={cn(cell, 'lg:col-span-5 lg:col-start-8 lg:row-start-1 xl:col-span-4')}>
          <Suspense fallback={<BlockSkeleton className="min-h-[140px]" />}>
            <TodoBlock
              review={review}
              connections={connections}
              upcoming={upcoming}
              canWrite={canWrite}
              now={now}
              timeZone={format.timeZone}
            />
          </Suspense>
        </div>
        <div className={cn(cell, 'lg:col-span-5 lg:col-start-8 lg:row-start-2 xl:col-span-4')}>
          <Suspense fallback={<BlockSkeleton className="min-h-[200px]" />}>
            <UpcomingBlock upcoming={upcoming} canWrite={canWrite} />
          </Suspense>
        </div>
        <div className={cn(cell, 'lg:col-span-12 lg:row-start-3')}>
          <Suspense fallback={<BlockSkeleton className="min-h-[260px]" />}>
            <NetWorthBlock netWorth={netWorth} currentMonth={monthStart(today)} />
          </Suspense>
        </div>
        <div className={cn(cell, 'lg:col-span-12 lg:row-start-4')}>
          <Suspense fallback={<BlockSkeleton className="min-h-[160px]" />}>
            <AccountsBlock
              accounts={accounts}
              connections={connections}
              now={now}
              locale={format.locale}
              timeZone={format.timeZone}
            />
          </Suspense>
        </div>
      </div>
    </PageContainer>
  );
}
