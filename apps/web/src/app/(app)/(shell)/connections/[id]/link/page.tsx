import {
  listAccounts,
  listConnectionAccounts,
  listConnections,
  type ConnectionAccountOption,
} from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ACCOUNT_TYPES } from '@/components/accounts/account-form-sheet';
import { LinkAccountsForm } from '@/components/connections/link-accounts-form';
import { EmptyState } from '@/components/empty-state';
import { FocusHeading } from '@/components/focus-heading';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { getConnectorDeps } from '@/server/connector-deps';
import { psuHeadersFrom } from '@/server/psu-headers';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('linkAccounts'))('title') };
}

const FROM = new Set(['consent', 'renewal', 't212']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LinkAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const requestHeaders = await headers();
  const session = await requireMember(requestHeaders, { roles: ['owner', 'member'] });
  const [{ id }, q, t, consent, common] = await Promise.all([
    params,
    searchParams,
    getTranslations('linkAccounts'),
    getTranslations('consent'),
    getTranslations('common'),
  ]);
  if (!UUID.test(id)) notFound();
  const ctx = toServiceCtx(session);
  const connection = (await listConnections(ctx)).find((c) => c.id === id);
  if (!connection) notFound();
  const from = FROM.has(q.from ?? '') ? q.from : undefined;
  const isT212 = connection.provider === 'trading212';
  const bank = connection.institutionName ?? connection.displayName;

  let options: ConnectionAccountOption[] | null = null;
  try {
    options = await listConnectionAccounts(
      ctx,
      await getConnectorDeps(),
      id,
      psuHeadersFrom(requestHeaders),
    );
  } catch (error) {
    // Provider error messages are sanitised (label and HTTP status only), so they are safe to log.
    console.error(
      `link accounts load failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`,
    );
  }
  const accounts = options ? await listAccounts(ctx, { includeArchived: true }) : [];

  // Outside the connect and renew flows this page manages the accounts of a running connection.
  const managing = connection.status !== 'pending' && from === undefined;
  const steps = isT212 ? 2 : 3;
  const header = (
    <PageHeader
      title={managing ? t('manageTitle') : t('title')}
      backHref="/connections"
      backLabel={common('back')}
      {...(managing
        ? {}
        : {
            description: consent('stepLine', {
              step: steps,
              total: steps,
              name: consent('steps.link'),
            }),
          })}
    />
  );

  if (options === null) {
    return (
      <PageContainer width="narrow">
        {header}
        <div className="grid grid-cols-1 max-w-[640px] gap-3">
          <Alert
            tone="error"
            action={
              <Link
                href={`/connections/${id}/link${from ? `?from=${from}` : ''}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {common('retry')}
              </Link>
            }
          >
            {t('loadFailed', { bank })}
          </Alert>
        </div>
        <FocusHeading />
      </PageContainer>
    );
  }

  if (options.length === 0) {
    return (
      <PageContainer width="narrow">
        {header}
        <EmptyState className="max-w-[640px]" title={t('emptyTitle', { bank })}>
          {t('emptyBody')}
          <Link href="/connections" className={`${buttonVariants({ variant: 'outline' })} mt-3`}>
            {t('backToConnections')}
          </Link>
        </EmptyState>
        <FocusHeading />
      </PageContainer>
    );
  }

  const unlinked = options.filter((o) => o.accountId === null).length;
  return (
    <PageContainer width="narrow">
      {header}
      <div className="mb-4 grid grid-cols-1 max-w-[640px] gap-3">
        <p className="max-w-[68ch] text-base">{t('lead', { bank })}</p>
        {from === 'renewal' && unlinked > 0 ? (
          <Alert tone="warning">{t('renewalNotice', { bank, count: unlinked })}</Alert>
        ) : null}
      </div>
      <LinkAccountsForm
        connectionId={id}
        options={options}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          currency: a.currency,
          ibanLast4: a.ibanLast4,
          archived: a.archivedAt !== null,
          connectionId: a.connectionId,
        }))}
        accountTypes={ACCOUNT_TYPES}
        defaultType={isT212 ? 'investment' : 'checking'}
        managing={managing}
      />
      <FocusHeading />
    </PageContainer>
  );
}
