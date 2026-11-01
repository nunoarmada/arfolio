import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import type { Metadata } from 'next';
import { AssetDetailView } from '@/components/net-worth/asset-detail';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { loadAssetDetail } from '@/server/net-worth-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('netWorth'))('title') };
}

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const [session, { id }, t, common] = await Promise.all([
    requireMember(await headers()),
    params,
    getTranslations('asset'),
    getTranslations('common'),
  ]);
  const canWrite = session.role !== 'viewer';
  const detail = await loadAssetDetail(toServiceCtx(session), id);
  return (
    <PageContainer>
      <PageHeader
        title={detail.asset.name}
        backHref="/net-worth"
        backLabel={common('back')}
        actions={
          canWrite ? (
            <Link
              href={`/net-worth/assets/${id}/edit`}
              aria-label={t('edit')}
              title={t('edit')}
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            >
              <Pencil className="size-5" aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />
      <AssetDetailView detail={detail} canWrite={canWrite} isOwner={session.role === 'owner'} />
    </PageContainer>
  );
}
