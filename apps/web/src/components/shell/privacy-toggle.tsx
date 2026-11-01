'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setPrivacyAction } from '@/app/actions/privacy';
import { RailTooltip, sidebarRowClass, sidebarRowTone } from '@/components/shell/nav';
import { cn } from '@/lib/cn';
import { useHydrated } from '@/lib/use-hydrated';
import { persistPrivacy } from '@/lib/privacy-setting';
import { usePrivacy } from '../privacy';
import { useToast } from '../ui/toast';

/**
 * Privacy mode switch: masks every amount on this device. A nav-styled row in the sidebar (above
 * the bell) and an icon button in the phone top bar. The name says what pressing it will do.
 */
export function PrivacyToggle({ variant }: { variant: 'sidebar' | 'topbar' }) {
  const t = useTranslations('privacy');
  const errors = useTranslations('actionErrors');
  const toast = useToast();
  const { hidden, setHidden } = usePrivacy();
  const [, startTransition] = useTransition();
  // Until hydration there is no click handler: disabled, so an early tap is not silently lost.
  const hydrated = useHydrated();
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    startTransition(() =>
      persistPrivacy(next, {
        save: setPrivacyAction,
        revert: setHidden,
        report: (error) => {
          console.error('privacy mode not saved', error);
          toast.error(errors('generic'));
        },
      }),
    );
  };
  const label = hidden ? t('show') : t('hide');
  const Icon = hidden ? EyeOff : Eye;

  if (variant === 'sidebar') {
    return (
      <button
        type="button"
        aria-pressed={hidden}
        disabled={!hydrated}
        aria-label={label}
        onClick={toggle}
        className={cn(sidebarRowClass, sidebarRowTone(false))}
      >
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        <span aria-hidden="true" className="sr-only xl:not-sr-only xl:truncate">
          {label}
        </span>
        <RailTooltip>{label}</RailTooltip>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={hidden}
      disabled={!hydrated}
      aria-label={label}
      onClick={toggle}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2"
    >
      <Icon className="size-6" aria-hidden="true" />
    </button>
  );
}
