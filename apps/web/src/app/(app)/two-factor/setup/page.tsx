import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { getBrand } from '@/lib/brand';
import { getSessionContext } from '@/server/session';
import { TwoFactorSetup } from './two-factor-setup';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('twoFactorSetup'))('title') };
}

export default async function TwoFactorSetupPage() {
  // Not requireMember: that guard sends owners without 2FA here, which would loop.
  const ctx = await getSessionContext(await headers());
  if (!ctx) redirect('/sign-in');
  const t = await getTranslations('twoFactorSetup');
  return (
    <AuthShell width="md">
      <h1 className="text-title">{t('title')}</h1>
      {ctx.user.twoFactorEnabled ? (
        <div className="mt-4 grid grid-cols-1 gap-4">
          <Alert tone="success">{t('alreadyEnabled')}</Alert>
          <Link href="/" className={buttonVariants({ size: 'lg' })}>
            {t('goHome')}
          </Link>
        </div>
      ) : (
        <TwoFactorSetup isOwner={ctx.role === 'owner'} brandName={getBrand().name} />
      )}
    </AuthShell>
  );
}
