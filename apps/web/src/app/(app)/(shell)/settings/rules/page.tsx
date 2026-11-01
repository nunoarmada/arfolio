import { listRules } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { RulesView } from '@/components/settings/rules-view';
import { loadLookups } from '@/server/lookups';
import { toRuleDto } from '@/server/serialize';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('rules'))('title') };
}

export default async function RulesPage() {
  const [session, t, settings] = await Promise.all([
    requireMember(await headers()),
    getTranslations('rules'),
    getTranslations('settings'),
  ]);
  const ctx = toServiceCtx(session);
  const [rules, lookups] = await Promise.all([listRules(ctx), loadLookups(ctx)]);
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <RulesView
        rules={rules.map(toRuleDto)}
        accounts={lookups.accounts}
        groups={lookups.groups}
        categories={lookups.categories}
        canWrite={session.role !== 'viewer'}
      />
    </>
  );
}
