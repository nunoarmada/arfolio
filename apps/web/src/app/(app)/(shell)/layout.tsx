import { countActiveConnections, reviewCount, unreadNotificationCount } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { HouseholdFormatProvider } from '@/components/household-format';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ShellProvider } from '@/components/shell/shell-context';
import { OfflineBanner } from '@/components/shell/offline-banner';
import { PrivacyToggle } from '@/components/shell/privacy-toggle';
import { SyncAllButton } from '@/components/shell/sync-all-button';
import { PrivacyProvider } from '@/components/privacy';
import { SidebarNav, TabBar, type NavItem } from '@/components/shell/nav';
import { TopBar } from '@/components/shell/top-bar';
import { UserMenu } from '@/components/shell/user-menu';
import { getBrand } from '@/lib/brand';
import { readPrivacy } from '@/lib/privacy-cookie';
import { loadHouseholdFormat } from '@/server/household-format';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

/**
 * The signed-in shell: top bar and bottom tabs on phones, an icon rail from md, the full sidebar from xl. Every page below passes
 * through requireMember, so no app page renders without a session, a household and (for owners)
 * enrolled two-step verification.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const ctx = await requireMember(await headers());
  const service = toServiceCtx(ctx);
  const [t, nav, review, brand, format, waiting, unread, hidden, syncable] = await Promise.all([
    getTranslations('shell'),
    getTranslations('nav'),
    getTranslations('review'),
    Promise.resolve(getBrand()),
    loadHouseholdFormat(service),
    reviewCount(service),
    unreadNotificationCount(service),
    readPrivacy(),
    // Viewers cannot refresh; a household without bank or broker connections has nothing to sync.
    ctx.role === 'viewer' ? Promise.resolve(0) : countActiveConnections(service),
  ]);
  // Later phases add more sections (never shown disabled).
  const home: NavItem = { href: '/', label: nav('home'), icon: 'home' };
  const transactions: NavItem = {
    href: '/transactions',
    label: nav('transactions'),
    icon: 'transactions',
    badge: waiting,
    badgeLabel: review('banner', { count: waiting }),
  };
  const budget: NavItem = { href: '/budget', label: nav('budget'), icon: 'budget' };
  const netWorth: NavItem = { href: '/net-worth', label: nav('netWorth'), icon: 'netWorth' };
  const main: NavItem[] = [
    home,
    transactions,
    budget,
    netWorth,
    { href: '/accounts', label: nav('accounts'), icon: 'accounts', also: ['/connections'] },
    { href: '/insights', label: nav('insights'), icon: 'insights' },
  ];
  const settings: NavItem[] = [{ href: '/settings', label: nav('settings'), icon: 'settings' }];
  // Phones: five tabs; Contas, Análises and Definições live behind Mais.
  const tabs: NavItem[] = [
    home,
    transactions,
    budget,
    netWorth,
    {
      href: '/more',
      label: nav('more'),
      icon: 'more',
      also: ['/accounts', '/connections', '/insights', '/settings'],
    },
  ];

  return (
    <HouseholdFormatProvider value={format}>
      <PrivacyProvider initialHidden={hidden}>
        <ShellProvider value={{ unread }}>
          <div className="min-h-dvh md:flex">
            <aside className="sticky top-0 z-20 hidden h-dvh w-[var(--sidebar-width-collapsed)] shrink-0 flex-col gap-4 border-r bg-sidebar p-3 md:flex xl:w-[var(--sidebar-width)] xl:p-4">
              <BrandMark
                brand={brand}
                className="min-h-11 justify-center xl:justify-start xl:px-1 max-xl:[&>span:last-child]:sr-only"
              />
              <SidebarNav items={main} label={t('navMain')} />
              <div className="mt-auto grid grid-cols-1 gap-3">
                <div className="grid grid-cols-1 gap-1">
                  {syncable > 0 ? <SyncAllButton /> : null}
                  <PrivacyToggle variant="sidebar" />
                  <NotificationBell unread={unread} variant="sidebar" />
                  <SidebarNav items={settings} label={t('navSettings')} />
                </div>
                <UserMenu name={ctx.user.name} email={ctx.user.email} />
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar brand={brand} />
              <OfflineBanner />
              <main
                id="main"
                tabIndex={-1}
                className="min-w-0 flex-1 px-4 pb-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+1.5rem)] pt-4 outline-none md:px-6 md:py-6 xl:px-8 xl:py-8 2xl:px-10"
              >
                {children}
              </main>
            </div>

            <TabBar items={tabs} label={t('navMain')} />
          </div>
        </ShellProvider>
      </PrivacyProvider>
    </HouseholdFormatProvider>
  );
}
