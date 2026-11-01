import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { IntegrationsView } from '@/components/integrations/integrations-view';
import { PageHeader } from '@/components/page-header';
import { getBrand } from '@/lib/brand';
import { getEnv } from '@/lib/env';
import { mcpUrl } from '@/lib/mcp-command';
import { loadIntegrations } from '@/server/integrations-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('integrations'))('title') };
}

export default async function IntegrationsPage() {
  const [session, t, settings] = await Promise.all([
    requireMember(await headers()),
    getTranslations('integrations'),
    getTranslations('settings'),
  ]);
  const data = await loadIntegrations(toServiceCtx(session));
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <IntegrationsView
        data={data}
        url={mcpUrl(getEnv().APP_URL)}
        brandName={getBrand().name}
        now={new Date().toISOString()}
        role={session.role}
      />
    </>
  );
}
