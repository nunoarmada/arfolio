import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { loadEncryptionKey } from '@arfolio/core/server';
import { PageHeader } from '@/components/page-header';
import { getBrand } from '@/lib/brand';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { loadServicesView } from '@/server/service-settings';
import { ServicesForm } from './services-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('services'))('title') };
}

export default async function ServicesPage() {
  const env = getEnv();
  const [view, t, settings] = await Promise.all([
    // Owner only: anyone else gets the 404 page, as if the section did not exist.
    loadServicesView(await headers(), {
      db: getDb(),
      encryptionKey: loadEncryptionKey(env.ENCRYPTION_KEY),
      env: process.env,
      appUrl: env.APP_URL,
      brandName: getBrand().name,
    }),
    getTranslations('services'),
    getTranslations('settings'),
  ]);
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('intro')}
        backHref="/settings"
        backLabel={settings('back')}
      />
      <ServicesForm view={view} />
    </>
  );
}
