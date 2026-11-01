'use client';

import { BellOff, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHouseholdFormat } from '@/components/household-format';
import { useFormatMoney } from '@/components/privacy';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { IconTile } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import type { ConnectionsT } from '@/lib/connection-copy';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/when';
import {
  loadNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  type NotificationPageDto,
} from '@/server/actions/connections';
import type { NotificationDto } from '@/server/notifications-data';
import { describeNotification } from './describe';

type Load = { state: 'idle' | 'loading' | 'error' | 'ready' };

/** The panel behind the bell: newest first, 20 at a time. Opening it does not mark anything read. */
export function NotificationPanel({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('notifications');
  const connections = useTranslations('connections');
  const common = useTranslations('common');
  const { locale, timeZone, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [more, setMore] = useState(false);
  const wasOpen = useRef(false);

  const fetchPage = useCallback(async (after: string | null) => {
    if (after) setMore(true);
    else setLoad({ state: 'loading' });
    let page: NotificationPageDto | null = null;
    try {
      const result = await loadNotificationsAction(after);
      page = result.ok ? result.data : null;
    } catch {
      page = null;
    }
    setMore(false);
    if (!page) return setLoad({ state: 'error' });
    setItems((cur) => (after ? [...cur, ...page.items] : page.items));
    setCursor(page.nextCursor);
    setLoad({ state: 'ready' });
  }, []);

  useEffect(() => {
    if (open && !wasOpen.current) void fetchPage(null);
    wasOpen.current = open;
  }, [open, fetchPage]);

  const unreadHere = items.filter((i) => !i.read).length;

  async function markRead(id: string) {
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read: true } : i)));
    try {
      await markNotificationReadAction(id);
    } catch {
      setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read: false } : i)));
    }
  }

  async function markAll() {
    const before = items;
    setItems((cur) => cur.map((i) => ({ ...i, read: true })));
    try {
      const result = await markAllNotificationsReadAction();
      if (!result.ok) setItems(before);
    } catch {
      setItems(before);
    }
  }

  const now = new Date();
  const ct = connections as unknown as ConnectionsT;
  const describe = (n: NotificationDto) =>
    describeNotification(n, {
      t: t as unknown as (key: string, values?: Record<string, string | number>) => string,
      connections: ct,
      locale,
      timeZone,
      currency,
      now,
      formatMoney,
    });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      tall
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="grid grid-cols-1 gap-3">
        {load.state === 'ready' && unreadHere > 0 ? (
          <Button
            variant="ghost"
            className="justify-self-end text-primary-text"
            onClick={() => void markAll()}
          >
            {t('markAll')}
          </Button>
        ) : null}

        {load.state === 'loading' || load.state === 'idle' ? (
          <div role="status" aria-busy="true" className="grid grid-cols-1 gap-3">
            <span className="sr-only">{common('loading')}</span>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : null}

        {load.state === 'error' ? (
          <Alert
            tone="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void fetchPage(null)}>
                {common('retry')}
              </Button>
            }
          >
            {t('loadFailed')}
          </Alert>
        ) : null}

        {load.state === 'ready' && items.length === 0 ? (
          <div className="grid grid-cols-1 justify-items-start gap-2 py-6">
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text"
            >
              <BellOff className="size-5" />
            </span>
            <p className="text-base font-semibold">{t('empty')}</p>
            <p className="max-w-[52ch] text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : null}

        {load.state === 'ready' && items.length > 0 ? (
          <ul
            aria-label={t('list')}
            className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card"
          >
            {items.map((n) => {
              const d = describe(n);
              const Icon = d.icon;
              return (
                <li
                  key={n.id}
                  className={cn(
                    'flex gap-3 p-4',
                    n.read ? '' : 'shadow-[inset_3px_0_0_var(--primary)]',
                  )}
                >
                  <IconTile
                    icon={Icon}
                    tone={
                      d.tone === 'warning' ? 'warning' : d.tone === 'info' ? 'primary' : 'negative'
                    }
                    className="size-8 rounded-lg [&>svg]:size-[18px]"
                  />
                  <div className="grid grid-cols-1 min-w-0 flex-1 gap-1">
                    <p className={cn('text-base', n.read ? 'font-normal' : 'font-medium')}>
                      {n.read ? null : (
                        <>
                          <span
                            aria-hidden="true"
                            className="mr-2 inline-block size-2 rounded-full bg-primary align-middle"
                          />
                          <span className="sr-only">{t('unread')}. </span>
                        </>
                      )}
                      {d.title}
                    </p>
                    <p className="text-sm text-muted-foreground">{d.body}</p>
                    <p className="text-sm text-muted-foreground">
                      <time dateTime={n.createdAt} className="whitespace-nowrap">
                        {relativeTime(n.createdAt, now, locale, connections('justNow'))}
                      </time>
                    </p>
                    <Link
                      href={d.action.href}
                      onClick={() => {
                        if (!n.read) void markRead(n.id);
                        onOpenChange(false);
                      }}
                      className={buttonVariants({
                        variant: 'outline',
                        size: 'sm',
                        className: 'mt-1 min-h-11 justify-self-start',
                      })}
                    >
                      {d.action.label}
                    </Link>
                  </div>
                  {n.read ? null : (
                    <button
                      type="button"
                      aria-label={t('markOne', { title: d.title })}
                      title={t('markOne', { title: d.title })}
                      onClick={() => void markRead(n.id)}
                      className="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
                    >
                      <Check className="size-5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {cursor ? (
          <Button
            variant="outline"
            loading={more}
            onClick={() => void fetchPage(cursor)}
            className="justify-self-center"
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
