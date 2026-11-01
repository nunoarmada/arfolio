import { listConnections } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Trading212Form } from '@/components/connections/trading212-form';
import { PageHeader } from '@/components/page-header';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('t212'))('title') };
}

export default async function Trading212Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, raw] = await Promise.all([
    requireMember(await headers(), { roles: ['owner', 'member'] }),
    searchParams,
  ]);
  const [t, consent, common] = await Promise.all([
    getTranslations('t212'),
    getTranslations('consent'),
    getTranslations('common'),
  ]);

  // `?connection=<id>`: replace the key of that Trading 212 connection (the card's "Atualizar chave").
  const wanted = Array.isArray(raw.connection) ? raw.connection[0] : raw.connection;
  if (wanted !== undefined) {
    const target = (await listConnections(toServiceCtx(session))).find(
      (c) => c.id === wanted && c.provider === 'trading212' && c.status !== 'revoked',
    );
    if (!target) redirect('/connections');
    return (
      <PageContainer width="narrow">
        <PageHeader
          title={t('updateTitle')}
          backHref="/connections"
          backLabel={common('back')}
          description={t('updateFor', { name: target.displayName })}
        />
        <Trading212Form connection={{ id: target.id, displayName: target.displayName }} />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t('title')}
        backHref="/connections/new"
        backLabel={common('back')}
        description={consent('stepLine', { step: 1, total: 2, name: consent('steps.apiKey') })}
      />
      <Trading212Form />
    </PageContainer>
  );
}
