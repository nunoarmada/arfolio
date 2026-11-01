import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { CategoriesView } from '@/components/settings/categories-view';
import { loadLookups } from '@/server/lookups';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('categories'))('title') };
}

export default async function CategoriesPage() {
  const [session, t, settings] = await Promise.all([
    requireMember(await headers()),
    getTranslations('categories'),
    getTranslations('settings'),
  ]);
  const lookups = await loadLookups(toServiceCtx(session));
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <CategoriesView groups={lookups.groups} canWrite={session.role !== 'viewer'} />
    </>
  );
}
