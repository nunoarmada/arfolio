import { getTransaction, NotFoundError } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { TransactionPage } from '@/components/transactions/transaction-page';
import { loadLookups } from '@/server/lookups';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { toTxDto } from '@/server/serialize';
import { loadRecentCategoryIds } from '@/server/transactions-data';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('transactions'))('detailTitle') };
}

/** Deep link to one movement (the list opens the same detail in a sheet). */
export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, { id }, t] = await Promise.all([
    requireMember(await headers()),
    params,
    getTranslations('transactions'),
  ]);
  const ctx = toServiceCtx(session);
  const row = await getTransaction(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [lookups, recentIds] = await Promise.all([loadLookups(ctx), loadRecentCategoryIds(ctx)]);
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t('detailTitle')}
        backHref="/transactions"
        backLabel={(await getTranslations('common'))('back')}
      />
      <div>
        <TransactionPage
          tx={toTxDto(row)}
          accounts={lookups.accounts}
          groups={lookups.groups}
          categories={lookups.categories}
          recentIds={recentIds}
          canWrite={session.role !== 'viewer'}
        />
      </div>
    </PageContainer>
  );
}
