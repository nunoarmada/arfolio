import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { getSessionContext } from '@/server/session';
import { TwoFactorForm } from './two-factor-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('twoFactor'))('title') };
}

export default async function TwoFactorChallengePage() {
  if (await getSessionContext(await headers())) redirect('/');
  const t = await getTranslations('twoFactor');
  return (
    <AuthShell>
      <h1 className="mb-2 text-title">{t('title')}</h1>
      <TwoFactorForm />
    </AuthShell>
  );
}
