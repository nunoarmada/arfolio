import { countAiAppliedSince, reviewCount } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { ReviewInbox } from '@/components/transactions/review-inbox';
import { loadLookups } from '@/server/lookups';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { loadRecentCategoryIds, loadReviewPage } from '@/server/transactions-data';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('review'))('title') };
}

export default async function ReviewPage() {
  const [session, t] = await Promise.all([
    requireMember(await headers()),
    getTranslations('review'),
  ]);
  const ctx = toServiceCtx(session);
  const [lookups, recentIds, total, initial, aiApplied] = await Promise.all([
    loadLookups(ctx),
    loadRecentCategoryIds(ctx),
    reviewCount(ctx),
    loadReviewPage(ctx, null),
    countAiAppliedSince(ctx, 30),
  ]);
  return (
    <PageContainer className="grid grid-cols-1 gap-4 [&>header]:mb-0">
      <PageHeader
        title={t('title')}
        backHref="/transactions"
        backLabel={(await getTranslations('common'))('back')}
        description={total > 0 ? t('count', { count: total }) : undefined}
      />
      <ReviewInbox
        initial={initial}
        total={total}
        accounts={lookups.accounts}
        groups={lookups.groups}
        categories={lookups.categories}
        recentIds={recentIds}
        canWrite={session.role !== 'viewer'}
        aiApplied={aiApplied}
      />
    </PageContainer>
  );
}
