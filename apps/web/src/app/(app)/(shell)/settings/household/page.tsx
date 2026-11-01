import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { currencyOptions, timeZoneOptions } from '@/lib/format';
import { REPORT_MAX_REGENERATIONS } from '@arfolio/services';
import { aiSettings, getHouseholdSettings } from '@/server/household';
import { requireMember } from '@/server/session';
import { HouseholdForm } from './household-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('household'))('title') };
}

export default async function HouseholdPage() {
  const h = await headers();
  const [ctx, settings, t, locale] = await Promise.all([
    requireMember(h),
    getHouseholdSettings(h),
    getTranslations('household'),
    getLocale(),
  ]);
  return (
    <>
      <PageHeader
        title={t('title')}
        backHref="/settings"
        backLabel={(await getTranslations('settings'))('back')}
      />
      <HouseholdForm
        initial={settings}
        canEdit={ctx.role === 'owner'}
        currencies={currencyOptions(locale)}
        timeZones={timeZoneOptions(settings.timezone)}
        {...await aiSettings()}
        maxRegenerations={REPORT_MAX_REGENERATIONS}
      />
    </>
  );
}
