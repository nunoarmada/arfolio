import { Building2, ChevronRight, TrendingUp } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { FocusHeading } from '@/components/focus-heading';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { cardVariants, IconTile } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { bankingEnabled } from '@/server/connector-deps';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('consent'))('newTitle') };
}

const CARD = cn(
  cardVariants({ variant: 'interactive' }),
  'flex min-h-[88px] items-center gap-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
);

export default async function NewConnectionPage() {
  // Viewers cannot add connections: the page is a 404 for them.
  await requireMember(await headers(), { roles: ['owner', 'member'] });
  const [t, common] = await Promise.all([getTranslations('consent'), getTranslations('common')]);
  const banking = await bankingEnabled();
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t('newTitle')}
        backHref="/connections"
        backLabel={common('back')}
        description={t('newLead')}
      />
      <ul className="grid grid-cols-1 max-w-[640px] gap-3">
        <li>
          {banking ? (
            <Link href="/connections/new/bank" className={CARD}>
              <IconTile icon={Building2} className="size-10 rounded-lg [&>svg]:size-5" />
              <span className="grid grid-cols-1 min-w-0 flex-1 gap-0.5">
                <span className="text-base font-medium">{t('providerBank')}</span>
                <span className="text-sm text-muted-foreground">{t('providerBankBody')}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          ) : (
            <div
              aria-disabled="true"
              className={cn(
                CARD,
                'bg-surface-2 text-muted-foreground shadow-none pointer-fine:hover:translate-y-0',
              )}
            >
              <IconTile
                icon={Building2}
                tone="neutral"
                className="size-10 rounded-lg [&>svg]:size-5"
              />
              <span className="grid grid-cols-1 min-w-0 flex-1 gap-0.5">
                <span className="text-base font-medium">{t('providerBank')}</span>
                <span className="text-sm">{t('unavailable')}</span>
              </span>
            </div>
          )}
        </li>
        <li>
          <Link href="/connections/new/trading212" className={CARD}>
            <IconTile icon={TrendingUp} className="size-10 rounded-lg [&>svg]:size-5" />
            <span className="grid grid-cols-1 min-w-0 flex-1 gap-0.5">
              <span className="text-base font-medium">{t('providerT212')}</span>
              <span className="text-sm text-muted-foreground">{t('providerT212Body')}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Link>
        </li>
      </ul>
      {banking ? null : (
        <div className="mt-4 max-w-[640px]">
          <Alert tone="info">{t('notConfigured')}</Alert>
        </div>
      )}
      <FocusHeading />
    </PageContainer>
  );
}
