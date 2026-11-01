import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { Bell, Languages, LogOut, SunMoon } from 'lucide-react';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { LocaleSwitch } from '@/components/locale-switch';
import { PageHeader } from '@/components/page-header';
import { PushSettings } from '@/components/settings/push-settings';
import { SettingsCard } from '@/components/settings/settings-card';
import { SignOutButton } from '@/components/sign-out-button';
import { Skeleton } from '@/components/ui/skeleton';
import { getBrand } from '@/lib/brand';
import { loadPushSettings } from '@/server/push-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { ThemeToggle } from './theme-toggle';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('preferences'))('title') };
}

/** Notificações: loads in its own boundary, so a slow or failing list never holds up the page. */
async function PushSection() {
  const [session, t] = await Promise.all([
    requireMember(await headers()),
    getTranslations('preferences.push'),
  ]);
  const { devices, vapidPublicKey } = await loadPushSettings(toServiceCtx(session));
  return (
    <SettingsCard titleId="push-title" title={t('title')} description={t('intro')} icon={Bell}>
      <PushSettings
        devices={devices}
        vapidPublicKey={vapidPublicKey}
        product={getBrand().name}
        now={new Date().toISOString()}
      />
    </SettingsCard>
  );
}

function PushSectionSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 rounded-lg bg-surface p-4 shadow-card md:p-5 xl:p-6"
      aria-hidden="true"
    >
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-10 w-full max-w-[68ch]" />
      <Skeleton className="h-11 w-full max-w-sm" />
    </div>
  );
}

export default async function PreferencesPage() {
  const [t, settings] = await Promise.all([
    getTranslations('preferences'),
    getTranslations('settings'),
  ]);
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <div className="grid grid-cols-1 gap-4 md:gap-5">
        <SettingsCard
          titleId="language-title"
          title={t('language')}
          description={t('languageHint')}
          icon={Languages}
        >
          <div>
            <LocaleSwitch />
          </div>
        </SettingsCard>
        <SettingsCard titleId="theme-title" title={t('theme')} icon={SunMoon}>
          <ThemeToggle />
        </SettingsCard>
        <Suspense fallback={<PushSectionSkeleton />}>
          <PushSection />
        </Suspense>
        <SettingsCard titleId="session-title" title={t('signOutTitle')} icon={LogOut}>
          <div>
            <SignOutButton />
          </div>
        </SettingsCard>
      </div>
    </>
  );
}
