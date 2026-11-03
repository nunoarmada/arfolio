'use client';

import { AlertTriangle, CheckCircle2, CreditCard, Landmark, Plus, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '../empty-state';
import { StatusChip } from '../ui/badge';
import { Card, IconTile } from '../ui/card';
import { KpiTile } from '../ui/kpi-tile';
import { SectionHeader } from '../ui/section-header';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Button, buttonVariants } from '../ui/button';
import type { AccountDto } from '@/server/serialize';
import { availableBalance, countsAsAvailable, shownBalance } from '@/lib/available';
import { accountSource } from '@/lib/account-source';
import { formatShortDay } from '@/lib/dates';
import { ACCOUNT_TYPES, AccountFormSheet } from './account-form-sheet';
import { TYPE_ICONS } from './type-icons';

export interface AccountRowDto extends AccountDto {
  /** ISO timestamp of the last non-undone import, or null for manual accounts. */
  lastImportAt: string | null;
  /** ISO timestamp of the linked connection's last successful sync, or null. */
  lastSyncAt: string | null;
}

/** Debts are normal, not alarming: only an overdrawn account of the other types reads as negative. */
const DEBT_TYPES = new Set(['card', 'loan']);

function AccountRow({ account }: { account: AccountRowDto }) {
  const t = useTranslations('accounts');
  const types = useTranslations('accounts.types');
  const { locale } = useHouseholdFormat();
  const source = accountSource(account);
  const fresh =
    source.kind === 'manual'
      ? t('manual')
      : source.at === null
        ? t('linked')
        : t(source.kind === 'synced' ? 'syncedOn' : 'importedOn', {
            date: formatShortDay(source.at.slice(0, 10), locale),
          });
  const Icon = TYPE_ICONS[account.type as keyof typeof TYPE_ICONS];
  return (
    <li>
      <Link
        href={`/accounts/${account.id}`}
        className="flex min-h-15 items-center gap-3 px-4 py-2.5 outline-none transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:min-h-16"
      >
        <IconTile
          icon={Icon}
          tone="neutral"
          className="size-9 rounded-full bg-surface-3 [&>svg]:size-[18px]"
        />
        <span className="grid min-w-0 flex-1 grid-cols-1">
          <span
            className="line-clamp-2 break-words text-[15px] font-medium leading-5"
            title={account.name}
          >
            {account.name}
          </span>
          <span className="truncate text-label font-normal text-muted-foreground">
            {[account.institutionName ?? types(account.type), fresh].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="grid shrink-0 justify-items-end">
          <MoneyAmount
            minor={shownBalance(account)}
            currency={account.currency}
            kind={DEBT_TYPES.has(account.type) ? 'neutral' : 'balance'}
            className="font-semibold"
          />
          {account.invested ? (
            <span className="flex items-baseline gap-1 text-label font-normal text-muted-foreground">
              {t('invested')}
              <MoneyAmount
                minor={account.invested}
                currency={account.currency}
                kind="balance"
                size="sm"
              />
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * Accounts: a KPI strip (available, cards, investments, connections with problems), then one card
 * per account type with its subtotal, two across from xl when there are four or more.
 */
export function AccountsView({
  accounts,
  canWrite,
  currencies,
  openNew,
  problems,
}: {
  accounts: AccountRowDto[];
  canWrite: boolean;
  currencies: Array<{ value: string; label: string }>;
  openNew: boolean;
  /** Connections that expired, failed or need renewal. */
  problems: number;
}) {
  const t = useTranslations('accounts');
  const types = useTranslations('accounts.types');
  const router = useRouter();
  const { currency } = useHouseholdFormat();
  const [adding, setAdding] = useState(openNew && canWrite);

  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);
  const { available, otherCurrency } = availableBalance(active, currency);
  const countedCount = active.filter(countsAsAvailable).length;
  // Cards count by what they owe (negative); investments by their whole value, cash included.
  const sumOf = (type: string) =>
    active
      .filter((a) => a.type === type && a.currency === currency)
      .reduce((sum, a) => sum + (type === 'investment' ? (a.balance ?? 0) : shownBalance(a)), 0);
  const countOf = (type: string) => active.filter((a) => a.type === type).length;
  const groupsShown = ACCOUNT_TYPES.filter((type) => active.some((a) => a.type === type));

  const addButton = canWrite ? (
    <Button onClick={() => setAdding(true)}>
      <Plus className="size-5" aria-hidden="true" />
      {t('add')}
    </Button>
  ) : null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:gap-6">
      {active.length > 0 ? (
        <div
          role="group"
          aria-label={t('kpiLabel')}
          className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
        >
          <KpiTile
            hero
            label={t('available')}
            icon={Landmark}
            value={
              <MoneyAmount
                minor={available}
                currency={currency}
                kind="balance"
                size="kpi"
                dimCents
              />
            }
            comparison={[
              t('kpiAccounts', { count: countedCount }),
              otherCurrency > 0 ? t('otherCurrency', { count: otherCurrency }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
          <KpiTile
            label={t('kpiCards')}
            icon={CreditCard}
            value={
              <MoneyAmount minor={sumOf('card')} currency={currency} kind="neutral" size="kpi" />
            }
            comparison={countOf('card') > 0 ? t('kpiCardsNote') : t('accountCount', { count: 0 })}
          />
          <KpiTile
            label={t('kpiInvestments')}
            icon={TrendingUp}
            value={
              <MoneyAmount
                minor={sumOf('investment')}
                currency={currency}
                kind="balance"
                size="kpi"
              />
            }
            comparison={t('kpiAccounts', { count: countOf('investment') })}
          />
          <KpiTile
            label={t('kpiProblems')}
            icon={problems > 0 ? AlertTriangle : CheckCircle2}
            href="/connections"
            value={
              <span
                className={cn(
                  'money-hero text-[26px] font-semibold leading-8 tracking-[-0.025em] tabular-nums max-sm:text-[22px] min-[1400px]:text-[30px] text-foreground',
                )}
              >
                {problems}
              </span>
            }
            delta={
              problems > 0 ? (
                <StatusChip
                  tone="negative"
                  icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}
                >
                  {t('kpiProblemsSome', { count: problems })}
                </StatusChip>
              ) : undefined
            }
            comparison={problems > 0 ? undefined : t('kpiProblemsNone')}
          />
        </div>
      ) : null}

      {active.length > 0 ? (
        <SectionHeader
          title={t('title')}
          count={active.length}
          action={addButton}
          className="mt-2"
        />
      ) : null}

      {active.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          action={
            canWrite ? (
              <div className="flex flex-wrap gap-3">
                {addButton}
                <Link href="/import" className={buttonVariants({ variant: 'outline' })}>
                  {t('importCsv')}
                </Link>
              </div>
            ) : undefined
          }
        >
          {t('emptyBody')}
        </EmptyState>
      ) : null}

      <div
        className={cn(
          'grid grid-cols-1 items-start gap-4 xl:gap-6',
          groupsShown.length >= 4 && 'xl:grid-cols-2',
        )}
      >
        {groupsShown.map((type) => {
          const group = active.filter((a) => a.type === type);
          const currencySet = new Set(group.map((a) => a.currency));
          const subtotal =
            currencySet.size === 1 ? group.reduce((sum, a) => sum + shownBalance(a), 0) : null;
          const Icon = TYPE_ICONS[type];
          return (
            <Card
              as="section"
              key={type}
              aria-labelledby={`group-${type}`}
              pad="none"
              className="overflow-hidden"
            >
              <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4 md:px-5 md:pt-5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IconTile icon={Icon} />
                  <h2 id={`group-${type}`} className="text-card-title">
                    {types(type)}
                  </h2>
                  <span className="text-label font-normal tabular-nums text-muted-foreground">
                    {group.length}
                  </span>
                </div>
                {subtotal !== null ? (
                  <MoneyAmount
                    minor={subtotal}
                    currency={group[0]!.currency}
                    kind={DEBT_TYPES.has(type) ? 'neutral' : 'balance'}
                    size="sm"
                    className="shrink-0 font-semibold text-muted-foreground"
                  />
                ) : null}
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {group.map((a) => (
                  <AccountRow key={a.id} account={a} />
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {archived.length > 0 ? (
        <details className="group rounded-lg bg-surface shadow-card">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-base font-medium">
            {t('archived', { count: archived.length })}
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {archived.map((a) => (
              <AccountRow key={a.id} account={a} />
            ))}
          </ul>
        </details>
      ) : null}

      {canWrite ? (
        <AccountFormSheet
          open={adding}
          onOpenChange={setAdding}
          currencies={currencies}
          defaultCurrency={currency}
          onSaved={(account) => router.push(`/accounts/${account.id}`)}
        />
      ) : null}
    </div>
  );
}
