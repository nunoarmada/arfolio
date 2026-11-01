import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { safeNext } from '@/lib/safe-redirect';
import { getSessionContext } from '@/server/session';
import { SignInForm } from './sign-in-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('signIn'))('title') };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  // Already signed in (and, for owners, enrolled): nothing to do here.
  const ctx = await getSessionContext(await headers());
  if (ctx) redirect(next);
  const t = await getTranslations('signIn');
  return (
    <AuthShell>
      <h1 className="mb-4 text-title">{t('title')}</h1>
      <SignInForm next={next} />
      <p className="mt-4 text-sm text-muted-foreground">{t('inviteOnly')}</p>
    </AuthShell>
  );
}
