'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageContainer } from '@/components/page-container';
import { Card, IconTile } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { SECTION_ICONS } from './settings-icons';

export interface SettingsSection {
  key: string;
  href: string;
  label: string;
  description: string;
}

export interface SettingsGroup {
  id: string;
  label: string;
  sections: SettingsSection[];
}

/**
 * Settings layout. /settings is the grouped list at every width (two columns of group cards from
 * xl). A section page from xl gets two panes: a sticky 260px sub-nav (every section one click
 * away) beside a narrow content column; below xl it shows only itself (phones get the header's
 * back chevron, tablets a back link above the page).
 */
export function SettingsFrame({
  groups,
  label,
  backLabel,
  children,
}: {
  groups: SettingsGroup[];
  label: string;
  backLabel: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isIndex = pathname === '/settings';
  return (
    <div
      className={cn(
        !isIndex && 'xl:grid xl:grid-cols-[260px_minmax(0,1fr)] xl:items-start xl:gap-10',
      )}
    >
      {/* The index page is the full grouped list itself; the sub-nav only sits beside a section. */}
      {isIndex ? null : (
        <nav aria-label={label} className="hidden xl:sticky xl:top-8 xl:block">
          <div className="grid grid-cols-1 gap-5">
            {groups.map((group) => (
              <div key={group.id} className="grid grid-cols-1 gap-1">
                <p
                  id={`subnav-${group.id}`}
                  className="px-3 pb-1 text-caption font-medium text-muted-foreground"
                >
                  {group.label}
                </p>
                <ul aria-labelledby={`subnav-${group.id}`} className="grid grid-cols-1 gap-0.5">
                  {group.sections.map((s) => {
                    const Icon = SECTION_ICONS[s.key];
                    const active = pathname === s.href || pathname.startsWith(`${s.href}/`);
                    return (
                      <li key={s.href}>
                        <Link
                          href={s.href}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-medium',
                            active
                              ? 'bg-primary-soft text-primary-text before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary'
                              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                          )}
                        >
                          {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
                          <span className="min-w-0 truncate">{s.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      )}
      <PageContainer width={isIndex ? 'wide' : 'narrow'} className="min-w-0">
        {isIndex ? null : (
          <Link
            href="/settings"
            className="-ml-2 mb-3 hidden min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary-text hover:underline md:inline-flex xl:hidden"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {backLabel}
          </Link>
        )}
        {children}
      </PageContainer>
    </div>
  );
}

/** The settings index: each group is a card of rows with 36px icon tiles, two columns from xl. */
export function SectionList({ groups }: { groups: SettingsGroup[] }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`group-${group.id}`} className="grid gap-2">
          <h2 id={`group-${group.id}`} className="px-1 text-label text-muted-foreground">
            {group.label}
          </h2>
          <Card as="ul" pad="none" className="divide-y divide-border overflow-hidden">
            {group.sections.map((s) => {
              const Icon = SECTION_ICONS[s.key];
              return (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    className="flex min-h-[60px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    {Icon ? (
                      <IconTile icon={Icon} className="size-9 rounded-lg [&>svg]:size-[18px]" />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium leading-5">{s.label}</span>
                      <span className="block text-label font-normal text-muted-foreground">
                        {s.description}
                      </span>
                    </span>
                    <ChevronRight
                      className="size-5 shrink-0 text-subtle-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              );
            })}
          </Card>
        </section>
      ))}
    </div>
  );
}
