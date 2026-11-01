'use client';

import { Check, ChevronsUpDown, Globe, LogOut, Palette } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useTheme } from 'next-themes';
import { useTransition } from 'react';
import { setLocaleAction } from '@/app/actions/locale';
import { useSignOut } from '@/components/sign-out-button';
import { RailTooltip } from '@/components/shell/nav';
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales';
import { cn } from '@/lib/cn';

const itemClass =
  'flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

/** Sidebar footer: avatar + name opening language, theme and sign-out. */
export function UserMenu({ name, email }: { name: string; email: string }) {
  const t = useTranslations('shell');
  const prefs = useTranslations('preferences');
  const locale = useLocale();
  const { theme, setTheme } = useTheme();
  const { signOut } = useSignOut();
  const [, startTransition] = useTransition();

  function chooseLocale(next: string) {
    const form = new FormData();
    form.set('locale', next);
    startTransition(() => void setLocaleAction(form));
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`${t('accountMenu')}: ${name}`}
        className="group relative flex min-h-12 w-full items-center justify-center gap-3 rounded-md px-2 text-left transition-colors duration-[120ms] hover:bg-surface-2 xl:justify-start xl:bg-surface-2/60 xl:ring-1 xl:ring-border"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft-strong text-sm font-semibold text-primary-text"
        >
          {Array.from(name)[0]?.toUpperCase() ?? '?'}
        </span>
        <span className="hidden min-w-0 flex-1 xl:block">
          <span title={name} className="block truncate text-sm font-medium">
            {name}
          </span>
          <span title={email} className="block truncate text-[13px] text-muted-foreground">
            {email}
          </span>
        </span>
        <ChevronsUpDown
          className="hidden size-4 shrink-0 text-muted-foreground xl:block"
          aria-hidden="true"
        />
        <RailTooltip>{name}</RailTooltip>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 min-w-60 rounded-lg bg-surface-raised p-1 shadow-raised"
        >
          <DropdownMenu.Label className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Globe className="size-4" aria-hidden="true" />
            {t('language')}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={locale} onValueChange={chooseLocale}>
            {LOCALES.map((l) => (
              <DropdownMenu.RadioItem
                key={l}
                value={l}
                lang={l}
                className={cn(itemClass, 'justify-between')}
              >
                {LOCALE_LABELS[l].name}
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Palette className="size-4" aria-hidden="true" />
            {t('theme')}
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
            {(['system', 'light', 'dark'] as const).map((value) => (
              <DropdownMenu.RadioItem
                key={value}
                value={value}
                className={cn(itemClass, 'justify-between')}
                onSelect={(e) => e.preventDefault()}
              >
                {prefs(`theme${value[0]!.toUpperCase()}${value.slice(1)}`)}
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4" aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={itemClass} onSelect={() => void signOut()}>
            <LogOut className="size-4" aria-hidden="true" />
            {t('signOut')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
