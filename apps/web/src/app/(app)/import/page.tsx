import { listAccounts } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronLeft } from 'lucide-react';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ImportWizard } from '@/components/import/import-wizard';
import { PageHeader } from '@/components/page-header';
import { currencyOptions } from '@/lib/format';
import { loadHouseholdFormat } from '@/server/household-format';
import { toAccountDto } from '@/server/serialize';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('import'))('title') };
}

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const [session, query, t, locale] = await Promise.all([
    requireMember(await headers(), { roles: ['owner', 'member'] }),
    searchParams,
    getTranslations('import'),
    getLocale(),
  ]);
  const accountParam = query.account && UUID.test(query.account) ? query.account : undefined;
  const ctx = toServiceCtx(session);
  const [accounts, format] = await Promise.all([listAccounts(ctx), loadHouseholdFormat(ctx)]);
  const back = accountParam ? `/accounts/${accountParam}` : '/transactions';
  return (
    <PageContainer width="full">
      <Link
        href={back}
        className="mb-4 hidden min-h-11 items-center gap-1 rounded-md pr-3 text-base text-muted-foreground hover:text-foreground md:inline-flex"
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
        {(await getTranslations('common'))('back')}
      </Link>
      <PageHeader
        title={t('title')}
        backHref={back}
        backLabel={(await getTranslations('common'))('back')}
      />
      <ImportWizard
        accounts={accounts.map(toAccountDto)}
        initialAccountId={accountParam}
        currencies={currencyOptions(locale)}
        defaultCurrency={format.currency}
      />
    </PageContainer>
  );
}
