import { listAccounts, listConnections, listImportBatches } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { AccountsView, type AccountRowDto } from '@/components/accounts/accounts-view';
import { ConnectionBanner } from '@/components/connections/connection-banner';
import { ConnectionsNav } from '@/components/connections/segmented-nav';
import { PageHeader } from '@/components/page-header';
import { connectionStatus, needsAttention } from '@/lib/connection-status';
import { currencyOptions } from '@/lib/format';
import { loadHouseholdFormat } from '@/server/household-format';
import { toAccountDto, toConnectionDto } from '@/server/serialize';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounts'))('title') };
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const [session, t, locale, query] = await Promise.all([
    requireMember(await headers()),
    getTranslations('accounts'),
    getLocale(),
    searchParams,
  ]);
  const ctx = toServiceCtx(session);
  const now = new Date();
  const [accounts, batches, connections, format] = await Promise.all([
    listAccounts(ctx, { includeArchived: true }),
    listImportBatches(ctx, { limit: 100 }),
    listConnections(ctx, { now }),
    loadHouseholdFormat(ctx),
  ]);
  const lastImport = new Map<string, string>();
  for (const b of batches) {
    if (!b.undoneAt && !lastImport.has(b.accountId))
      lastImport.set(b.accountId, b.createdAt.toISOString());
  }
  const rows: AccountRowDto[] = accounts.map((a) => ({
    ...toAccountDto(a),
    lastImportAt: lastImport.get(a.id) ?? null,
  }));
  const problems = connections
    .map(toConnectionDto)
    .filter((c) => needsAttention(connectionStatus(c, now, format.timeZone).key)).length;
  return (
    <PageContainer>
      <PageHeader title={t('title')} tabs={<ConnectionsNav current="accounts" />} />
      <div className="mb-4 empty:hidden">
        <ConnectionBanner
          connections={connections.map(toConnectionDto)}
          now={now}
          timeZone={format.timeZone}
        />
      </div>
      <AccountsView
        accounts={rows}
        canWrite={session.role !== 'viewer'}
        currencies={currencyOptions(locale)}
        openNew={query.new === '1'}
        problems={problems}
      />
    </PageContainer>
  );
}
