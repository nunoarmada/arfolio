'use client';

import {
  ArrowLeftRight,
  ChartColumn,
  ChartLine,
  Ellipsis,
  House,
  Landmark,
  PiggyBank,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export type NavIcon =
  'home' | 'transactions' | 'budget' | 'netWorth' | 'accounts' | 'insights' | 'settings' | 'more';
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Count shown as a pill (the review inbox); 0 or missing shows nothing. */
  badge?: number;
  /** Full sentence for the badge, read by screen readers ("7 movimentos por rever"). */
  badgeLabel?: string;
  /** Other path prefixes that keep this item active (Contas also covers /connections, Mais covers Contas and Definições). */
  also?: string[];
}

const ICONS: Record<NavIcon, LucideIcon> = {
  home: House,
  transactions: ArrowLeftRight,
  budget: PiggyBank,
  netWorth: ChartLine,
  accounts: Landmark,
  insights: ChartColumn,
  settings: Settings,
  more: Ellipsis,
};

function Badge({ item, className }: { item: NavItem; className?: string }) {
  if (!item.badge || item.badge <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground',
          className,
        )}
      >
        {item.badge > 99 ? '99+' : item.badge}
      </span>
      <span className="sr-only">{item.badgeLabel}</span>
    </>
  );
}

function isActive(pathname: string, item: Pick<NavItem, 'href' | 'also'>): boolean {
  const matches = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  return matches(item.href) || (item.also ?? []).some(matches);
}

/**
 * CSS-only tooltip for the icon rail (md to xl). Decorative: the link's visually hidden label
 * is its accessible name. It shows on hover and on keyboard focus, and is gone once the labels
 * are visible (xl).
 */
export function RailTooltip({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-[var(--shadow-md)] transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-visible:opacity-100 xl:hidden"
    >
      {children}
    </span>
  );
}

/** Class shared by every row of the sidebar (links and the bell button): rail below xl, full row from xl. */
export const sidebarRowClass =
  'group relative flex min-h-11 w-full items-center justify-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] xl:justify-start';

export function sidebarRowTone(active: boolean): string {
  return active
    ? 'bg-primary-soft text-primary-text before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary'
    : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground';
}

/** Sidebar links: a 72px icon rail from md, icon + label from xl. */
export function SidebarNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="grid grid-cols-1 gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(sidebarRowClass, sidebarRowTone(active))}
              >
                <span className="relative flex shrink-0">
                  <Icon className="size-5" aria-hidden="true" />
                  {item.badge ? (
                    <span
                      aria-hidden="true"
                      className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-sidebar xl:hidden"
                    />
                  ) : null}
                </span>
                <span className="sr-only xl:not-sr-only xl:truncate">{item.label}</span>
                <Badge item={item} className="hidden xl:ml-auto xl:flex" />
                <RailTooltip>{item.label}</RailTooltip>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Mobile bottom tab bar: icon over a 12px label, the whole cell is the target. Cells size to their
 * content and share the leftover width equally, so short labels ("Início", "Mais") give room to
 * long ones ("Movimentos", "Património") instead of every cell being a fifth of the screen.
 */
export function TabBar({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-surface/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <ul className="flex h-[var(--tabbar-height)]">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="flex-auto">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-full min-h-14 flex-col items-center justify-center gap-0.5 whitespace-nowrap px-1 text-xs font-medium',
                  active ? 'font-semibold text-primary-text' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'relative flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-[120ms]',
                    active && 'bg-primary-soft',
                  )}
                >
                  <Icon className="size-6" aria-hidden="true" />
                  <Badge item={item} className="absolute right-2 -top-1.5 ring-2 ring-surface" />
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
