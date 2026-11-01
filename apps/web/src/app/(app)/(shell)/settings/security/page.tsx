import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { MIN_PASSWORD_LENGTH } from '@/lib/credentials';
import { requireMember } from '@/server/session';
import { SecurityView } from './security-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('security'))('title') };
}

export default async function SecurityPage() {
  const [ctx, t, settings] = await Promise.all([
    requireMember(await headers()),
    getTranslations('security'),
    getTranslations('settings'),
  ]);
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <SecurityView
        twoFactorEnabled={Boolean(ctx.user.twoFactorEnabled)}
        isOwner={ctx.role === 'owner'}
        currentSessionId={ctx.session.id}
        minPassword={MIN_PASSWORD_LENGTH}
      />
    </>
  );
}
