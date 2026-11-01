import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { ExitedList } from '@/components/net-worth/exited-list';
import { NetWorthAddMenu } from '@/components/net-worth/add-menu';
import { NetWorthNav } from '@/components/net-worth/net-worth-nav';
import { NetWorthView } from '@/components/net-worth/net-worth-view';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { loadNetWorthPage, parseRange } from '@/server/net-worth-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('netWorth'))('title') };
}

export default async function NetWorthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, query, t] = await Promise.all([
    requireMember(await headers()),
    searchParams,
    getTranslations('netWorth'),
  ]);
  const canWrite = session.role !== 'viewer';
  const data = await loadNetWorthPage(toServiceCtx(session), parseRange(query.range));

  return (
    <PageContainer>
      <PageHeader
        title={t('title')}
        tabs={<NetWorthNav />}
        actions={canWrite ? <NetWorthAddMenu /> : undefined}
      />
      {data.kind === 'empty' ? (
        <div className="grid grid-cols-1 gap-6">
          <EmptyState
            title={t('emptyTitle')}
            action={
              canWrite ? (
                <div className="flex flex-wrap gap-3">
                  <Link href="/net-worth/assets/new" className={buttonVariants({})}>
                    {t('addAssetAction')}
                  </Link>
                  <Link
                    href="/net-worth/liabilities/new"
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {t('addLiabilityAction')}
                  </Link>
                  <Link href="/import/budget" className={buttonVariants({ variant: 'outline' })}>
                    {t('importSheet')}
                  </Link>
                </div>
              ) : undefined
            }
          >
            {t('emptyBody')}
          </EmptyState>
          <ExitedList items={data.exited} />
        </div>
      ) : (
        <NetWorthView data={data} canWrite={canWrite} />
      )}
    </PageContainer>
  );
}
