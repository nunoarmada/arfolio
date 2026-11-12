'use client';

import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useHouseholdFormat } from '@/components/household-format';
import { RailTooltip, sidebarRowClass, sidebarRowTone } from '@/components/shell/nav';
import { useToast } from '@/components/ui/toast';
import { useFailureMessage } from '@/components/use-action-error';
import { atLabels, type ConnectionsT } from '@/lib/connection-copy';
import { cn } from '@/lib/cn';
import { syncAllMessage, type SyncAllT } from '@/lib/sync-all-copy';
import { useHydrated } from '@/lib/use-hydrated';
import { dayTime } from '@/lib/when';
import { syncAllAction } from '@/server/actions/connections';

/**
 * "Sync all": a manual refresh of every active connection. A sidebar row above the privacy
 * switch, and an icon button in the phone top bar. Each connection keeps its own manual refresh
 * allowance; one toast sums up the run.
 */
export function SyncAllButton({ variant }: { variant: 'sidebar' | 'topbar' }) {
  const t = useTranslations('syncAll');
  const connections = useTranslations('connections');
  const common = useTranslations('common');
  const toast = useToast();
  const failure = useFailureMessage();
  const router = useRouter();
  const { locale, timeZone } = useHouseholdFormat();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);

  async function syncAll() {
    if (pending) return;
    setPending(true);
    try {
      const result = await syncAllAction();
      if (!result.ok) {
        const message = result.code === 'forbidden' ? failure(result) : t('error');
        toast.error(message, { label: common('retry'), onClick: () => void syncAll() });
        return;
      }
      const labels = atLabels(connections as unknown as ConnectionsT);
      const { tone, message } = syncAllMessage(t as unknown as SyncAllT, result.data, (iso) =>
        dayTime(iso, new Date(), locale, timeZone, labels),
      );
      toast[tone](message);
      router.refresh();
    } catch (error) {
      console.error(`sync all failed: ${error instanceof Error ? error.name : 'unknown'}`);
      toast.error(t('error'), { label: common('retry'), onClick: () => void syncAll() });
    } finally {
      setPending(false);
    }
  }

  const label = pending ? t('syncing') : t('label');
  const icon = (size: string) => (
    <RefreshCw
      className={cn(size, 'shrink-0', pending && 'animate-spin motion-reduce:animate-none')}
      aria-hidden="true"
    />
  );
  // Until hydration there is no click handler: disabled, so an early tap is not silently lost.
  const buttonProps = {
    type: 'button' as const,
    disabled: !hydrated,
    'aria-busy': pending,
    'aria-label': label,
    onClick: () => void syncAll(),
  };

  if (variant === 'topbar') {
    return (
      <button
        {...buttonProps}
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2',
          pending && 'cursor-progress',
        )}
      >
        {icon('size-6')}
      </button>
    );
  }

  return (
    <button
      {...buttonProps}
      className={cn(sidebarRowClass, sidebarRowTone(false), pending && 'cursor-progress')}
    >
      {icon('size-5')}
      <span aria-hidden="true" className="sr-only xl:not-sr-only xl:truncate">
        {t('label')}
      </span>
      <RailTooltip>{label}</RailTooltip>
    </button>
  );
}
