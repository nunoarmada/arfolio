import {
  ChartColumn,
  ChevronRight,
  Landmark,
  Palette,
  Settings,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { SignOutButton } from '@/components/sign-out-button';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';
import { Card, IconTile } from '@/components/ui/card';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('more'))('title') };
}

/** Phones only have five tabs: the rest of the app is one tap away from here. */
export default async function MorePage() {
  const [session, t] = await Promise.all([requireMember(await headers()), getTranslations('more')]);
  type Row = { href: string; label: string; description: string; Icon: LucideIcon };
  const explore: Row[] = [
    { href: '/accounts', label: t('accounts'), description: t('accountsHelp'), Icon: Landmark },
    { href: '/insights', label: t('insights'), description: t('insightsHelp'), Icon: ChartColumn },
    { href: '/net-worth/goals', label: t('goals'), description: t('goalsHelp'), Icon: Target },
  ];
  const settings: Row[] = [
    { href: '/settings', label: t('settings'), description: t('settingsHelp'), Icon: Settings },
    {
      href: '/settings/preferences',
      label: t('appearance'),
      description: t('appearanceHelp'),
      Icon: Palette,
    },
  ];
  const group = (rows: Row[]) => (
    <Card as="ul" pad="none" className="divide-y divide-border overflow-hidden">
      {rows.map(({ href, label, description, Icon }) => (
        <li key={href}>
          <Link
            href={href}
            className="flex min-h-[60px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
          >
            <IconTile icon={Icon} className="size-9 rounded-lg [&>svg]:size-[18px]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium leading-5">{label}</span>
              <span className="block text-label font-normal text-muted-foreground">
                {description}
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-subtle-foreground" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </Card>
  );
  return (
    <PageContainer width="narrow">
      <PageHeader title={t('title')} />
      <div className="grid grid-cols-1 gap-4">
        <nav aria-label={t('navLabel')} className="grid grid-cols-1 gap-4">
          {group(explore)}
          {group(settings)}
        </nav>

        <Card as="section" aria-labelledby="more-user" pad="sm" className="grid grid-cols-1 gap-3">
          <h2 id="more-user" className="sr-only">
            {t('user')}
          </h2>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-base font-semibold text-primary-text"
            >
              {Array.from(session.user.name)[0]?.toUpperCase() ?? '?'}
            </span>
            <p className="grid grid-cols-1 min-w-0">
              <span className="truncate text-base font-medium">{session.user.name}</span>
              <span className="truncate text-sm text-muted-foreground">{session.user.email}</span>
            </p>
          </div>
          <SignOutButton className="w-full" />
        </Card>
      </div>
    </PageContainer>
  );
}
