import { listAccounts, listConnections, listImportBatches } from '@arfolio/services';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { AccountActions } from '@/components/accounts/account-actions';
import { HoldingsSection } from '@/components/accounts/holdings-section';
import { ImportBatches } from '@/components/accounts/import-batches';
import { TYPE_ICONS } from '@/components/accounts/type-icons';
import { MoneyAmount } from '@/components/money-amount';
import { Card, IconTile } from '@/components/ui/card';
import { StatusChip } from '@/components/ui/badge';
import { SectionHeader } from '@/components/ui/section-header';
import { PageHeader } from '@/components/page-header';
import { AddMenu } from '@/components/transactions/add-menu';
import { TransactionsView } from '@/components/transactions/transactions-view';
import { assertValidId } from '@/lib/ids';
import { accountSource } from '@/lib/account-source';
import { formatShortDay, todayIn } from '@/lib/dates';
import { currencyOptions } from '@/lib/format';
import { filtersToParams, parseFilters } from '@/lib/transaction-filters';
import { getFormatMoney } from '@/server/format-money';
import { loadHoldings } from '@/server/holdings-data';
import { loadHouseholdFormat } from '@/server/household-format';
import { loadLookups } from '@/server/lookups';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { loadRecentCategoryIds, loadTransactionsPage } from '@/server/transactions-data';
import { PageContainer } from '@/components/page-container';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('accounts'))('title') };
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, { id }, raw, t, types, locale] = await Promise.all([
    requireMember(await headers()),
    params,
    searchParams,
    getTranslations('accounts'),
    getTranslations('accounts.types'),
    getLocale(),
  ]);
  assertValidId(id);
  const ctx = toServiceCtx(session);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
      search.append(key, v);
  }
  const filters = parseFilters(search, 'all');
  const query = filtersToParams({ ...filters, accountIds: [id] }, 'all').toString();
  const [
    format,
    accounts,
    lookups,
    recentIds,
    batches,
    holdings,
    initial,
    formatMoney,
    connections,
  ] = await Promise.all([
    loadHouseholdFormat(ctx),
    listAccounts(ctx, { includeArchived: true }),
    loadLookups(ctx),
    loadRecentCategoryIds(ctx),
    listImportBatches(ctx, { accountId: id, limit: 10 }),
    loadHoldings(ctx, id),
    loadTransactionsPage(
      ctx,
      filtersToParams({ ...filters, accountIds: [id] }, 'all').toString(),
      null,
      'all',
    ),
    getFormatMoney(),
    listConnections(ctx),
  ]);
  const account = accounts.find((a) => a.id === id);
  if (!account) notFound();
  const dto = lookups.accounts.find((a) => a.id === id)!;
  const canWrite = session.role !== 'viewer';
  const batchKey = batches.map((b) => `${b.id}:${b.undoneAt ? 1 : 0}`).join(',');
  // A card is shown by what it owes; its balance may be the bank's available credit.
  const owed = account.type === 'card' ? (account.owed ?? 0) : null;
  const money = (minor: number) => formatMoney(minor, account.currency, format.locale);

  const lastImport = batches.find((b) => b.undoneAt === null);
  const lastSuccess = connections.find((c) =>
    c.accounts.some((a) => a.accountId === id),
  )?.lastSuccessAt;
  const source = accountSource({
    connectionId: account.connectionId,
    lastSyncAt: lastSuccess ? lastSuccess.toISOString() : null,
    lastImportAt: lastImport ? lastImport.createdAt.toISOString() : null,
  });
  const TypeIcon = TYPE_ICONS[account.type as keyof typeof TYPE_ICONS];
  const synced =
    source.kind === 'manual'
      ? t('manual')
      : source.at === null
        ? t('linked')
        : t(source.kind === 'synced' ? 'syncedOn' : 'importedOn', {
            date: formatShortDay(source.at.slice(0, 10), locale),
          });

  return (
    <PageContainer className="grid grid-cols-1 gap-4 xl:gap-6 [&>header]:mb-0">
      <PageHeader
        title={account.name}
        backHref="/accounts"
        backLabel={(await getTranslations('common'))('back')}
        actions={
          canWrite && !account.archivedAt ? (
            <AddMenu importAccountId={id} variant="outline" />
          ) : undefined
        }
      />
      <Card variant="hero" as="section" aria-labelledby="balance-title" className="grid gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <div className="flex items-center gap-2.5">
              <IconTile icon={TypeIcon} />
              <h2 id="balance-title" className="text-label text-muted-foreground">
                {owed !== null ? t('owed') : t('balance')}
                {account.archivedAt ? ` · ${t('archivedTag')}` : ''}
              </h2>
            </div>
            <MoneyAmount
              minor={owed ?? account.cash}
              currency={account.currency}
              kind={owed !== null ? 'neutral' : 'balance'}
              size="hero"
              dimCents
            />
            {owed !== null ? (
              <p className="text-sm text-muted-foreground">
                {account.creditLimit !== null
                  ? t('cardAvailable', {
                      available: money(Math.max(0, account.creditLimit - owed)),
                      limit: money(account.creditLimit),
                    })
                  : t('cardNoLimit')}
              </p>
            ) : null}
            {account.invested !== 0 ? (
              <p
                data-testid="account-invested"
                className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground"
              >
                <span>{t('invested')}</span>
                <MoneyAmount
                  minor={account.invested}
                  currency={account.currency}
                  kind="balance"
                  className="font-semibold text-foreground"
                />
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="neutral" icon={<span className="sr-only" />}>
                {types(account.type)}
              </StatusChip>
              {account.institutionName ? (
                <StatusChip tone="neutral" icon={<span className="sr-only" />}>
                  {account.institutionName}
                </StatusChip>
              ) : null}
              <StatusChip tone={source.kind === 'manual' ? 'neutral' : 'primary'}>
                {synced}
              </StatusChip>
            </div>
          </div>
          {canWrite ? (
            <AccountActions
              account={dto}
              currencies={currencyOptions(locale)}
              isOwner={session.role === 'owner'}
            />
          ) : null}
        </div>
      </Card>

      {account.type === 'investment' || (holdings && holdings.items.length > 0) ? (
        <HoldingsSection holdings={holdings} today={todayIn(format.timeZone)} />
      ) : null}

      <ImportBatches
        batches={batches.map((b) => ({
          id: b.id,
          filename: b.filename,
          createdAt: b.createdAt.toISOString(),
          rowsImported: b.rowsImported,
          rowsDuplicate: b.rowsDuplicate,
          undone: b.undoneAt !== null,
        }))}
        canWrite={canWrite}
      />

      <section aria-labelledby="account-tx-title" className="grid grid-cols-1 gap-3">
        <SectionHeader id="account-tx-title" title={t('movements')} />
        <TransactionsView
          resetKey={`${query}|${batchKey}`}
          initial={initial}
          filters={filters}
          defaultPeriod="all"
          today={todayIn(format.timeZone)}
          accounts={lookups.accounts}
          groups={lookups.groups}
          categories={lookups.categories}
          recentIds={recentIds}
          canWrite={canWrite && !account.archivedAt}
          basePath={`/accounts/${id}`}
          lockAccountId={id}
          openManual={search.get('add') === 'manual'}
        />
      </section>
    </PageContainer>
  );
}
