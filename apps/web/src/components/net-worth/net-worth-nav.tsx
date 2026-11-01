'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { PageTabs } from '@/components/page-tabs';

/**
 * Resumo · Objetivos: two pages of the Património tab, as links (not a tab list), drawn as the
 * page header's underline tabs.
 */
export function NetWorthNav() {
  const t = useTranslations('netWorth');
  const pathname = usePathname();
  const items = [
    { href: '/net-worth', label: t('navSummary') },
    { href: '/net-worth/goals', label: t('navGoals') },
  ];
  return (
    <PageTabs
      label={t('navLabel')}
      items={items.map((item) => ({ ...item, active: pathname === item.href }))}
    />
  );
}
