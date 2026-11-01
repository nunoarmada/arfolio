import { listBanks, listConnections, type BankSummary } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { BankPicker } from '@/components/connections/bank-picker';
import { PageHeader } from '@/components/page-header';
import { countryOptions, defaultCountry, isBankCountry } from '@/lib/countries';
import { bankingEnabled, getConnectorDeps } from '@/server/connector-deps';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('consent'))('bankTitle') };
}

export default async function ChooseBankPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string }>;
}) {
  const session = await requireMember(await headers(), { roles: ['owner', 'member'] });
  if (!(await bankingEnabled())) redirect('/connections/new');
  const ctx = toServiceCtx(session);
  const [t, common, locale, query] = await Promise.all([
    getTranslations('consent'),
    getTranslations('common'),
    getLocale(),
    searchParams,
  ]);
  const connections = await listConnections(ctx);
  const latest = connections
    .filter((c) => c.provider === 'enablebanking' && c.institutionCountry)
    .at(-1)?.institutionCountry;
  const country = isBankCountry(query.country)
    ? query.country
    : defaultCountry(locale, latest ?? null);

  let banks: BankSummary[] = [];
  let loadFailed = false;
  if (country) {
    try {
      banks = await listBanks(ctx, await getConnectorDeps(), country);
    } catch (error) {
      loadFailed = true;
      console.error(`bank list failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
  banks = [...banks].sort((a, b) => a.name.localeCompare(b.name, locale));

  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t('bankTitle')}
        backHref="/connections/new"
        backLabel={common('back')}
        description={t('stepLine', { step: 1, total: 3, name: t('steps.chooseBank') })}
      />
      <BankPicker
        country={country}
        countries={countryOptions(locale)}
        banks={banks.map((b) => ({ name: b.name, ...(b.beta ? { beta: true } : {}) }))}
        loadFailed={loadFailed}
      />
    </PageContainer>
  );
}
