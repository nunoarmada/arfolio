'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

const OPTIONS = ['system', 'light', 'dark'] as const;
const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/** System / Claro / Escuro as a radio group (one tab stop, arrow keys move the choice). */
export function ThemeToggle() {
  const t = useTranslations('preferences');
  const { theme, setTheme } = useTheme();
  // next-themes only knows the stored theme on the client: avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? (theme ?? 'system') : 'system';
  return (
    <div
      role="radiogroup"
      aria-label={t('theme')}
      className="inline-flex w-fit max-w-full justify-self-start gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {OPTIONS.map((value) => {
        const active = current === value;
        const Icon = ICONS[value];
        return (
          <label
            key={value}
            className={cn(
              'flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] sm:min-w-24 lg:pointer-fine:min-h-9 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              active
                ? 'bg-surface text-primary-text shadow-card'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={active}
              onChange={() => setTheme(value)}
              className="sr-only"
            />
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {t(`theme${value[0]!.toUpperCase()}${value.slice(1)}`)}
          </label>
        );
      })}
    </div>
  );
}
