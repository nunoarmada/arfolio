'use client';

import { Bell } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { RailTooltip, sidebarRowClass, sidebarRowTone } from '@/components/shell/nav';
import { cn } from '@/lib/cn';
import { NotificationPanel } from './notification-panel';
import { returnFocusToTrigger } from './return-focus';

/**
 * The bell: a nav-styled button in the sidebar (above Definições) and an icon button in the
 * phone top bar. It is not a link, it opens the notifications panel. The name carries the count.
 */
export function NotificationBell({
  unread,
  variant,
}: {
  unread: number;
  variant: 'sidebar' | 'topbar';
}) {
  const t = useTranslations('notifications');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = unread > 0 ? t('bellUnread', { count: unread }) : t('bell');
  const shown = unread > 99 ? '99+' : String(unread);

  return (
    <>
      {variant === 'sidebar' ? (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen(true)}
          className={cn(sidebarRowClass, sidebarRowTone(false))}
        >
          <span className="relative flex shrink-0">
            <Bell className="size-5" aria-hidden="true" />
            {unread > 0 ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-sidebar xl:hidden"
              />
            ) : null}
          </span>
          <span aria-hidden="true" className="sr-only xl:not-sr-only xl:truncate">
            {t('bell')}
          </span>
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="hidden h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground xl:ml-auto xl:flex"
            >
              {shown}
            </span>
          ) : null}
          <RailTooltip>{t('bell')}</RailTooltip>
        </button>
      ) : (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen(true)}
          className="relative -mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2"
        >
          <Bell className="size-6" aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold leading-5 text-primary-foreground ring-2 ring-background',
              )}
            >
              {shown}
            </span>
          ) : null}
        </button>
      )}
      <NotificationPanel
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(e) => {
          // There is no Dialog.Trigger, so Radix has nothing to return focus to: do it here,
          // but not over a page that a panel link opened and that has already taken focus.
          e.preventDefault();
          returnFocusToTrigger(trigger.current, document);
        }}
      />
    </>
  );
}
