import { listBudgets } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { BudgetsList } from '@/components/budget/budgets-list';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { toBudgetDto } from '@/server/budget-data';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetList'))('title') };
}

export default async function BudgetsListPage() {
  const [session, t] = await Promise.all([
    requireMember(await headers()),
    getTranslations('budgetList'),
  ]);
  const budgets = (await listBudgets(toServiceCtx(session))).map(toBudgetDto);
  const canWrite = session.role !== 'viewer';
  return (
    <PageContainer width="narrow">
      <PageHeader title={t('title')} backHref="/budget/year" backLabel={t('back')} />
      {budgets.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          action={
            canWrite ? (
              <Link href="/budget/new" className={buttonVariants({})}>
                {t('create')}
              </Link>
            ) : undefined
          }
        >
          {t('emptyBody')}
        </EmptyState>
      ) : (
        <BudgetsList budgets={budgets} canWrite={canWrite} />
      )}
    </PageContainer>
  );
}
