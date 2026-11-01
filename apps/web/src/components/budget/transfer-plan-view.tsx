'use client';

import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { BudgetLineView } from '@arfolio/services';
import { truncateName } from '@/lib/budget-import-copy';
import { formatMonth } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { monthParam } from '@/lib/budget-period';
import type { AccountDto } from '@/server/serialize';
import { AccountBadge } from '../account-badge';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Card } from '../ui/card';
import { SectionHeader } from '../ui/section-header';
import { useFormatMoney } from '@/components/privacy';

export interface PlanData {
  hubAccountId: string;
  perAccount: Array<{ accountId: string; amount: number; surplus: number }>;
  hubIncome: number;
  hubOutgoing: number;
  remainingInHub: number;
  negative: boolean;
}

/** What to move from the main account to each account this month, and what is left behind. */
export function TransferPlanView({
  plan,
  lines,
  accounts,
  month,
  budgetId,
}: {
  plan: PlanData;
  lines: BudgetLineView[];
  accounts: AccountDto[];
  month: string;
  /** Only when a budget was opened on purpose. */
  budgetId?: string;
}) {
  const t = useTranslations('transferPlan');
  const kinds = useTranslations('budget.kinds');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const hubName = truncateName(byId.get(plan.hubAccountId)?.name ?? t('removedAccount'), 40);
  const monthName = formatMonth(month, locale);
  const nameOf = (id: string) => byId.get(id)?.name;

  const moving = plan.perAccount
    .filter((p) => p.amount > 0)
    .sort(
      (a, b) =>
        b.amount - a.amount || (nameOf(a.accountId) ?? '').localeCompare(nameOf(b.accountId) ?? ''),
    );
  const surplus = plan.perAccount.filter((p) => p.surplus > 0);
  const total = moving.reduce((sum, p) => sum + p.amount, 0);
  const budgetHref = `/budget?${new URLSearchParams({ month: monthParam(month), ...(budgetId ? { budget: budgetId } : {}) }).toString()}`;

  const remainingText = plan.negative ? (
    <span className="text-negative">
      <MoneyAmount minor={plan.remainingInHub} currency={currency} kind="balance" />
      <span className="text-sm"> {t('short')}</span>
    </span>
  ) : (
    <MoneyAmount minor={plan.remainingInHub} currency={currency} kind="balance" />
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-start xl:gap-6">
      <Card
        as="section"
        aria-labelledby="plan-answer"
        variant={plan.negative ? 'default' : 'hero'}
        className="lg:col-span-12"
        tone={plan.negative ? 'negative' : 'none'}
      >
        <h2 id="plan-answer" className="sr-only">
          {t('answerTitle')}
        </h2>
        {plan.negative ? (
          <div className="grid grid-cols-1 gap-2">
            <p className="flex items-start gap-2 text-lg font-semibold">
              <AlertTriangle className="mt-1 size-5 shrink-0 text-negative" aria-hidden="true" />
              <span>
                {t.rich('shortAnswer', {
                  amount: () => (
                    <span className="whitespace-nowrap tabular-nums">
                      {money(Math.abs(plan.remainingInHub))}
                    </span>
                  ),
                  hub: hubName,
                  month: monthName,
                })}
              </span>
            </p>
            <p className="text-sm text-foreground">{t('shortBody', { hub: hubName })}</p>
            <Link
              href={budgetHref}
              className="inline-flex min-h-11 items-center justify-self-start text-base text-primary underline underline-offset-4"
            >
              {t('seeBudget', { month: monthName })}
            </Link>
          </div>
        ) : total > 0 ? (
          <div className="grid grid-cols-1 gap-1">
            <p className="flex flex-wrap items-baseline gap-x-2 text-base">
              {t.rich('answer', {
                total: () => (
                  <MoneyAmount minor={total} currency={currency} kind="transfer" size="lg" />
                ),
                hub: hubName,
                month: monthName,
                count: moving.length,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('stays', { hub: hubName })} {remainingText}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1">
            <p className="text-base font-medium">{t('nothing', { month: monthName })}</p>
            <p className="text-sm text-muted-foreground">
              {t('stays', { hub: hubName })} {remainingText}
            </p>
          </div>
        )}
      </Card>

      <section aria-labelledby="plan-breakdown" className="grid grid-cols-1 gap-2 lg:col-span-5">
        <SectionHeader id="plan-breakdown" title={t('breakdown')} />
        <Card as="dl" pad="none" className="divide-y divide-border px-4 md:px-5">
          {(
            [
              [t('hubIncome', { hub: hubName }), money(plan.hubIncome), false],
              [t('hubOutgoing', { hub: hubName }), money(plan.hubOutgoing), false],
              [t('transfers'), money(total), false],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-3">
              <dt className="min-w-0 text-sm text-muted-foreground">{label}</dt>
              <dd className="text-base tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className="min-w-0 text-sm font-medium">{t('staysLabel', { hub: hubName })}</dt>
            <dd className="text-base font-semibold tabular-nums">{remainingText}</dd>
          </div>
        </Card>
      </section>

      <div className="grid grid-cols-1 gap-4 empty:hidden lg:col-span-7 xl:gap-6">
        {moving.length > 0 ? (
          <section aria-labelledby="plan-moves" className="grid grid-cols-1 gap-2">
            <SectionHeader id="plan-moves" title={t('moveTo')} count={moving.length} />
            <Card as="ul" pad="none" className="divide-y divide-border overflow-hidden">
              {moving.map((p) => {
                const account = byId.get(p.accountId);
                const forLines = lines.filter(
                  (l) => l.accountId === p.accountId && l.kind !== 'income' && l.planned > 0,
                );
                const expanded = open === p.accountId;
                return (
                  <li key={p.accountId} className="px-4 py-3">
                    <div className="flex min-h-[40px] items-center gap-3">
                      {account ? (
                        <AccountBadge
                          name={account.name}
                          type={account.type}
                          variant="full"
                          className="flex-1"
                        />
                      ) : (
                        <span className="flex-1 text-base text-muted-foreground">
                          {t('removedAccount')}
                        </span>
                      )}
                      <MoneyAmount minor={p.amount} currency={currency} kind="transfer" size="md" />
                    </div>
                    {forLines.length > 0 ? (
                      <div className="mt-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={`plan-lines-${p.accountId}`}
                          onClick={() => setOpen(expanded ? null : p.accountId)}
                          className="flex min-h-11 items-center gap-1 text-sm text-primary"
                        >
                          <ChevronDown
                            className={cn(
                              'size-4 transition-transform duration-[180ms]',
                              !expanded && '-rotate-90',
                            )}
                            aria-hidden="true"
                          />
                          {t('forLines', { count: forLines.length })}
                        </button>
                        {expanded ? (
                          <ul
                            id={`plan-lines-${p.accountId}`}
                            className="grid grid-cols-1 gap-1 pb-1 pl-5 text-sm"
                          >
                            {forLines.map((l) => (
                              <li
                                key={l.lineId}
                                className="flex items-baseline justify-between gap-3"
                              >
                                <span className="min-w-0 truncate">
                                  {truncateName(l.name, 60)}
                                  <span className="text-muted-foreground"> · {kinds(l.kind)}</span>
                                </span>
                                <span className="tabular-nums">{money(l.planned)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </Card>
          </section>
        ) : null}

        {surplus.length > 0 ? (
          <section aria-labelledby="plan-surplus" className="grid grid-cols-1 gap-2">
            <SectionHeader id="plan-surplus" title={t('surplusTitle')} count={surplus.length} />
            <Card as="ul" pad="none" className="divide-y divide-border overflow-hidden">
              {surplus.map((p) => {
                const account = byId.get(p.accountId);
                return (
                  <li key={p.accountId} className="flex min-h-14 items-center gap-3 px-4 py-2">
                    {account ? (
                      <AccountBadge
                        name={account.name}
                        type={account.type}
                        variant="full"
                        className="flex-1"
                      />
                    ) : (
                      <span className="flex-1 text-base text-muted-foreground">
                        {t('removedAccount')}
                      </span>
                    )}
                    <MoneyAmount minor={p.surplus} currency={currency} kind="balance" />
                  </li>
                );
              })}
            </Card>
            <p className="text-sm text-muted-foreground">{t('surplusHelp', { hub: hubName })}</p>
          </section>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground lg:col-span-12">{t('footnote')}</p>
    </div>
  );
}
