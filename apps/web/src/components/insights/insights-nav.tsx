import { getTranslations } from 'next-intl/server';
import { PageTabs } from '@/components/page-tabs';

/**
 * "Gráficos · Relatórios": two links under the page title, drawn as the page
 * header's underline tabs. Not a tab list: each is a page of its own.
 */
export async function InsightsNav({ current }: { current: 'charts' | 'reports' }) {
  const t = await getTranslations('reports.nav');
  const items = [
    { id: 'charts', href: '/insights', label: t('charts') },
    { id: 'reports', href: '/insights/reports', label: t('reports') },
  ] as const;
  return (
    <PageTabs
      label={t('label')}
      items={items.map((item) => ({
        href: item.href,
        label: item.label,
        active: current === item.id,
      }))}
    />
  );
}
