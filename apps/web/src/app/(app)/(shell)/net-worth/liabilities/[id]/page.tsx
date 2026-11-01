import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import type { Metadata } from 'next';
import { LiabilityDetailView } from '@/components/net-worth/liability-detail';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { loadLiabilityDetail } from '@/server/net-worth-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('netWorth'))('title') };
}

export default async function LiabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const [session, { id }, t, common] = await Promise.all([
    requireMember(await headers()),
    params,
    getTranslations('liability'),
    getTranslations('common'),
  ]);
  const canWrite = session.role !== 'viewer';
  const detail = await loadLiabilityDetail(toServiceCtx(session), id);
  return (
    <PageContainer>
      <PageHeader
        title={detail.liability.name}
        backHref="/net-worth"
        backLabel={common('back')}
        actions={
          canWrite ? (
            <Link
              href={`/net-worth/liabilities/${id}/edit`}
              aria-label={t('edit')}
              title={t('edit')}
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            >
              <Pencil className="size-5" aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />
      <LiabilityDetailView detail={detail} canWrite={canWrite} isOwner={session.role === 'owner'} />
    </PageContainer>
  );
}
