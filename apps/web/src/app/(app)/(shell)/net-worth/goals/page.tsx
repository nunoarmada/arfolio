import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { GoalsLoadError } from '@/components/net-worth/goals-error';
import { GoalsView } from '@/components/net-worth/goals-view';
import { NetWorthNav } from '@/components/net-worth/net-worth-nav';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { loadGoalsPage, type GoalsPageData } from '@/server/goals-data';
import { getHouseholdSettings } from '@/server/household';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('goals'))('title') };
}

export default async function GoalsPage() {
  const h = await headers();
  const [session, t] = await Promise.all([requireMember(h), getTranslations('goals')]);
  const canWrite = session.role !== 'viewer';

  let data: GoalsPageData | null = null;
  try {
    const settings = await getHouseholdSettings(h);
    data = await loadGoalsPage(toServiceCtx(session), settings.emergencyFundMonths);
  } catch (error) {
    // Control flow (redirects, 404s) carries a digest: let Next handle it. Anything else is shown.
    if (typeof (error as { digest?: unknown })?.digest === 'string') throw error;
    console.error(`goals page failed: ${error instanceof Error ? error.name : 'unknown error'}`);
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('title')}
        tabs={<NetWorthNav />}
        actions={
          canWrite ? (
            <Link href="/net-worth/goals/new" className={buttonVariants({})}>
              <Plus className="size-4" aria-hidden="true" />
              {t('add')}
            </Link>
          ) : undefined
        }
      />
      {data ? (
        <GoalsView data={data} canWrite={canWrite} isOwner={session.role === 'owner'} />
      ) : (
        <GoalsLoadError />
      )}
    </PageContainer>
  );
}
