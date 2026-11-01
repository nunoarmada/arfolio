import { listBanks, listConnections } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthorisePanel } from '@/components/connections/authorise-panel';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { isBankCountry } from '@/lib/countries';
import { bankingEnabled, getConnectorDeps } from '@/server/connector-deps';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('consent'))('steps.authorise') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AuthorisePage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; aspsp?: string; connection?: string }>;
}) {
  const session = await requireMember(await headers(), { roles: ['owner', 'member'] });
  if (!(await bankingEnabled())) redirect('/connections/new');
  const ctx = toServiceCtx(session);
  const [t, common, q] = await Promise.all([
    getTranslations('consent'),
    getTranslations('common'),
    searchParams,
  ]);

  // Renewal: the bank and country come from the stored connection, never from the URL.
  let renewalId: string | undefined;
  let country: string | undefined = q.country;
  let aspspName: string | undefined = q.aspsp?.slice(0, 200);
  let missing = false;
  if (q.connection !== undefined) {
    const found = UUID.test(q.connection)
      ? (await listConnections(ctx)).find(
          (c) => c.id === q.connection && c.provider === 'enablebanking',
        )
      : undefined;
    if (found?.institutionName && found.institutionCountry) {
      renewalId = found.id;
      aspspName = found.institutionName;
      country = found.institutionCountry;
    } else {
      missing = true;
    }
  }
  const valid = !missing && isBankCountry(country) && !!aspspName;
  if (!valid) {
    return (
      <PageContainer width="narrow">
        <PageHeader
          title={t('steps.authorise')}
          backHref="/connections"
          backLabel={common('back')}
        />
        <div className="grid grid-cols-1 max-w-[640px] gap-3">
          <Alert tone="error">{missing ? t('errGone') : t('errUnknownBank')}</Alert>
          <Link
            href="/connections"
            className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}
          >
            {t('goToConnections')}
          </Link>
        </div>
      </PageContainer>
    );
  }

  // The bank's own maximum validity, when the provider list is reachable (best effort).
  let maxConsentDays: number | undefined;
  try {
    maxConsentDays = (await listBanks(ctx, await getConnectorDeps(), country!)).find(
      (b) => b.name === aspspName,
    )?.maxConsentDays;
  } catch {
    maxConsentDays = undefined;
  }

  const renew = renewalId !== undefined;
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t(renew ? 'titleRenew' : 'title', { bank: aspspName! })}
        backHref={
          renew ? '/connections' : `/connections/new/bank?country=${encodeURIComponent(country!)}`
        }
        backLabel={common('back')}
        {...(renew
          ? {}
          : {
              description: t('stepLine', { step: 2, total: 3, name: t('steps.authorise') }),
            })}
      />
      <AuthorisePanel
        bank={aspspName!}
        country={country!}
        aspspName={aspspName!}
        {...(renewalId ? { connectionId: renewalId } : {})}
        {...(maxConsentDays !== undefined ? { maxConsentDays } : {})}
      />
    </PageContainer>
  );
}
