import { listAccounts } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { monthOptions } from '@/lib/format';
import { getHouseholdSettings } from '@/server/household';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { BudgetSettingsForm } from './budget-settings-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetSettings'))('title') };
}

export default async function BudgetSettingsPage() {
  const h = await headers();
  const [session, settings, t, locale] = await Promise.all([
    requireMember(h),
    getHouseholdSettings(h),
    getTranslations('budgetSettings'),
    getLocale(),
  ]);
  const accounts = await listAccounts(toServiceCtx(session), { includeArchived: true });
  return (
    <>
      <PageHeader
        title={t('title')}
        backHref="/settings"
        backLabel={(await getTranslations('settings'))('back')}
      />
      <BudgetSettingsForm
        initial={{
          fiscalYearStartMonth: settings.fiscalYearStartMonth,
          hubAccountId: settings.hubAccountId,
          thresholds: settings.budgetAlertThresholds,
        }}
        canEdit={session.role === 'owner'}
        months={monthOptions(locale)}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          archived: a.archivedAt !== null,
        }))}
      />
    </>
  );
}
