import { getTranslations } from 'next-intl/server';
import { PageTabs } from '@/components/page-tabs';

/**
 * "Contas · Ligações": two links under the page title, drawn as the page header's
 * underline tabs. Not a tab list: each is a page.
 */
export async function ConnectionsNav({ current }: { current: 'accounts' | 'connections' }) {
  const t = await getTranslations('connections');
  const items = [
    { id: 'accounts', href: '/accounts', label: t('navAccounts') },
    { id: 'connections', href: '/connections', label: t('navConnections') },
  ] as const;
  return (
    <PageTabs
      label={t('navLabel')}
      items={items.map((item) => ({
        href: item.href,
        label: item.label,
        active: current === item.id,
      }))}
    />
  );
}
