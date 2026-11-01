import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { appVersionLabel } from '@/lib/app-version';
import { PageHeader } from '@/components/page-header';
import { SignOutButton } from '@/components/sign-out-button';
import { getSettingsGroups } from './sections';
import { SectionList } from './settings-frame';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('settings'))('title') };
}

export default async function SettingsIndexPage() {
  const [groups, t] = await Promise.all([getSettingsGroups(), getTranslations('settings')]);
  return (
    <>
      <PageHeader title={t('title')} description={t('intro')} />
      <SectionList groups={groups} />
      {/* Phones have no sidebar user menu: sign-out lives here. */}
      <div className="mt-6 md:hidden">
        <SignOutButton className="w-full" />
      </div>
      <p className="text-muted-foreground mt-6 text-center text-xs">
        <span className="sr-only">{t('version')}: </span>
        {appVersionLabel()}
        {' · '}
        {/* AGPL section 13: offer the source to every user of the running service. */}
        <a
          href="https://github.com/nunoarmada/arfolio"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {t('sourceCode')}
        </a>
      </p>
    </>
  );
}
