'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageTabs } from '@/components/page-tabs';

/**
 * Mês · Ano · Transferências · Subscrições: four pages of one budget, as links (not a tab list),
 * drawn as the page header's underline tabs. The month and the budget the
 * reader is looking at travel along.
 */
export function BudgetNav({
  month,
  budgetId,
  start,
  trailing,
}: {
  /** `yyyy-mm` being looked at, kept when moving between Mês and Transferências. */
  month?: string;
  /** Set only when a budget was opened on purpose (an archived one): keeps it pinned. */
  budgetId?: string;
  /** Start month (`yyyy-mm`) of the budget in view, for the year grid. */
  start?: string;
  /** Sits on the right of the tab row from md (the period stepper), below the tabs on phones. */
  trailing?: ReactNode;
}) {
  const t = useTranslations('budgetNav');
  const pathname = usePathname();
  const query = (entries: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(entries)) if (value) params.set(key, value);
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const items = [
    { href: '/budget', to: `/budget${query({ month, budget: budgetId })}`, label: t('month') },
    {
      href: '/budget/year',
      to: `/budget/year${query(budgetId ? { budget: budgetId } : { start })}`,
      label: t('year'),
    },
    {
      href: '/budget/transfers',
      to: `/budget/transfers${query({ month, budget: budgetId })}`,
      label: t('transfers'),
    },
    { href: '/budget/subscriptions', to: '/budget/subscriptions', label: t('subscriptions') },
  ];
  const tabs = (
    <PageTabs
      label={t('label')}
      items={items.map((item) => ({
        href: item.to,
        label: item.label,
        active: pathname === item.href,
      }))}
    />
  );
  if (!trailing) return tabs;
  return (
    <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between md:gap-4 md:shadow-[inset_0_-1px_0_var(--border)]">
      <div className="min-w-0 md:flex-1">{tabs}</div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}
