'use client';

import { AlertDialog } from 'radix-ui';
import { CircleHelp, Monitor, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useHydrated } from '@/lib/use-hydrated';
import { describeDevice } from '@/lib/push-device';
import { relativeTime } from '@/lib/when';
import type { PushDeviceDto } from '@/server/push-data';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { useHouseholdFormat } from '../household-format';

/** The label of a device ("Chrome em Android"), shared by its row, its button name and its dialog. */
function useDeviceLabel(): (userAgent: string | null) => string {
  const t = useTranslations('preferences.push');
  return (userAgent) => {
    const device = describeDevice(userAgent);
    return device
      ? t('deviceLabel', { browser: device.browser, os: device.os })
      : t('unknownDevice');
  };
}

/**
 * "Os seus dispositivos". Removing the current device is the same as turning notifications off
 * here, so it goes straight to `onRemoveThisDevice`; any other device asks first, because only
 * that device can turn itself on again.
 */
export function PushDeviceList({
  devices,
  thisDeviceId,
  now,
  onRemoveThisDevice,
  onRemoveOther,
}: {
  /** Null when the list could not be loaded. */
  devices: PushDeviceDto[] | null;
  thisDeviceId: string | null;
  now: string;
  onRemoveThisDevice: () => Promise<boolean>;
  onRemoveOther: (id: string) => Promise<boolean>;
}) {
  const t = useTranslations('preferences.push');
  const common = useTranslations('common');
  const label = useDeviceLabel();
  const hydrated = useHydrated();
  const router = useRouter();
  const { locale, timeZone } = useHouseholdFormat();
  const [asking, setAsking] = useState<PushDeviceDto | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once the removed row has left the list (the next row, or the heading).
  const focusAfter = useRef<{ index: number; before: string } | null>(null);
  const ids = devices?.map((d) => d.id).join(',') ?? '';

  useEffect(() => {
    const target = focusAfter.current;
    // Focus moves once the list has really dropped the row and the dialog (which traps focus) is gone.
    if (!target || !devices || asking || ids === target.before) return;
    const remaining = devices.length;
    if (remaining === 0) heading.current?.focus();
    else buttons.current.get(devices[Math.min(target.index, remaining - 1)]!.id)?.focus();
    focusAfter.current = null;
  }, [ids, asking, devices]);

  async function remove(device: PushDeviceDto, viaDialog: boolean) {
    focusAfter.current = {
      index: devices?.findIndex((d) => d.id === device.id) ?? 0,
      before: ids,
    };
    if (viaDialog) setPending(true);
    const ok =
      device.id === thisDeviceId ? await onRemoveThisDevice() : await onRemoveOther(device.id);
    if (viaDialog) {
      setPending(false);
      if (ok) setAsking(null);
      setFailed(!ok);
    }
    if (!ok) focusAfter.current = null;
  }

  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(
      new Date(iso),
    );

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-1">
        <h3 ref={heading} tabIndex={-1} className="text-card-title outline-none">
          {t('devicesTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('devicesHelp')}</p>
      </div>
      {devices === null ? (
        <Alert
          tone="error"
          action={
            <Button variant="link" onClick={() => router.refresh()}>
              {common('retry')}
            </Button>
          }
        >
          {t('devicesError')}
        </Alert>
      ) : devices.length === 0 ? (
        <p className="rounded-md bg-surface-2 p-4 text-sm text-muted-foreground">
          {t('devicesEmpty')}
        </p>
      ) : (
        <ul
          data-testid="push-devices"
          className="divide-y divide-border overflow-hidden rounded-md bg-surface-2"
        >
          {devices.map((device) => {
            const kind = describeDevice(device.userAgent)?.kind;
            const Icon = kind === 'phone' ? Smartphone : kind === 'computer' ? Monitor : CircleHelp;
            const name = label(device.userAgent);
            const mine = device.id === thisDeviceId;
            return (
              <li key={device.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    <span className="min-w-0 break-words">{name}</span>
                    {mine ? (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 text-caption text-primary-text">
                        {t('thisDevice')}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('since', { date: date(device.createdAt) })}
                    {' · '}
                    {device.lastSuccessAt
                      ? t('lastDelivery', {
                          when: relativeTime(
                            device.lastSuccessAt,
                            new Date(now),
                            locale,
                            t('justNow'),
                          ),
                        })
                      : t('noDelivery')}
                    {device.failureCount > 0 ? (
                      <span className="font-medium text-warning">
                        {' · '}
                        {t('failing')}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Button
                  ref={(el) => {
                    if (el) buttons.current.set(device.id, el);
                    else buttons.current.delete(device.id);
                  }}
                  variant="outline"
                  className="h-11 shrink-0 md:h-9 md:px-3 md:text-sm"
                  disabled={!hydrated}
                  aria-label={t('removeNamed', { device: name })}
                  onClick={(event) => {
                    if (mine) void remove(device, false);
                    else {
                      setFailed(false);
                      opener.current = event.currentTarget;
                      setAsking(device);
                    }
                  }}
                >
                  {t('remove')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog.Root
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setAsking(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <AlertDialog.Content
            onCloseAutoFocus={(event) => {
              // Focus is always placed by hand: back on the Remover that opened the dialog, or
              // (after a removal, when that row is gone) by the list effect above.
              event.preventDefault();
              if (!focusAfter.current) opener.current?.focus();
            }}
            className="fixed left-1/2 top-1/2 z-[70] grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          >
            <AlertDialog.Title className="text-lg font-semibold">
              {t('removeTitle', { device: asking ? label(asking.userAgent) : '' })}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-base text-muted-foreground">
              {t('removeBody')}
            </AlertDialog.Description>
            {failed ? <Alert tone="error">{t('removeError')}</Alert> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialog.Cancel asChild>
                <Button variant="outline" disabled={pending}>
                  {common('cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                variant="destructive"
                loading={pending}
                onClick={() => asking && void remove(asking, true)}
              >
                {t('remove')}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
