'use client';

import { BellOff, BellRing, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { derivePushState, detectIos, isStandalone, type PushEnv } from '@/lib/push-state';
import { sameApplicationServerKey, urlBase64ToBytes } from '@/lib/push-device';
import {
  findThisDeviceAction,
  sendTestPushAction,
  subscribePushAction,
  unsubscribePushAction,
} from '@/server/actions/push';
import type { PushDeviceDto } from '@/server/push-data';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { useToast } from '../ui/toast';
import { PushDeviceList } from './push-device-list';

const READY_TIMEOUT_MS = 8000;
const TEST_COOLDOWN_MS = 60_000;

/** The service worker registration, or a rejection when none becomes ready (no worker, no push). */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('service worker not ready')), READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Inspected {
  env: PushEnv;
  /** The device row for this browser's subscription. */
  deviceId: string | null;
  /** The browser's subscription used an old VAPID key and could not be replaced. */
  replaceFailed?: boolean;
}

/**
 * Swaps a browser subscription made with another VAPID key (the instance's key changed) for one
 * made with the current key, and saves it. The server row of the old endpoint goes first, so a
 * failure there leaves both sides as they were; once the old subscription is dropped, a failure
 * while resubscribing or saving drops the new one too, so no orphan stays behind. Throws on failure.
 */
async function replaceStaleSubscription(
  registration: ServiceWorkerRegistration,
  stale: PushSubscription,
  vapidPublicKey: string,
): Promise<string> {
  const removed = await unsubscribePushAction({ endpoint: stale.endpoint });
  if (!removed.ok) throw new Error('stale row not removed');
  await stale.unsubscribe();
  const fresh = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(vapidPublicKey),
  });
  try {
    const saved = await subscribePushAction({
      endpoint: fresh.endpoint,
      keys: fresh.toJSON().keys,
      userAgent: navigator.userAgent,
    });
    if (!saved.ok) throw new Error('not saved');
    return saved.data.id;
  } catch (error) {
    await fresh.unsubscribe().catch(() => false);
    throw error;
  }
}

/** What this browser can do and has done. Never asks for permission: that is the button's job. */
async function inspect(vapidPublicKey: string | null): Promise<Inspected> {
  const supported =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = detectIos(navigator.userAgent, navigator.maxTouchPoints);
  const installed = isStandalone({
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
  });
  const permission = supported ? Notification.permission : 'default';
  const env: PushEnv = { supported, ios, installed, permission, registered: false };
  if (!supported || permission !== 'granted') return { env, deviceId: null };
  try {
    const registration = await readyRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { env, deviceId: null };
    const found = await findThisDeviceAction(subscription.endpoint);
    // The server could not say: unknown (null), not "not registered".
    if (!found.ok) return { env: { ...env, registered: null }, deviceId: null };
    const id = found.data?.id ?? null;
    if (
      id !== null &&
      vapidPublicKey &&
      !sameApplicationServerKey(subscription.options?.applicationServerKey, vapidPublicKey)
    ) {
      // The VAPID key changed since this user's device subscribed: the old subscription is dead.
      // The permission is already granted, so replacing it needs no prompt. Only this user's own
      // device is replaced here; anyone else's stale subscription waits for "Ativar" (enable()).
      try {
        const newId = await replaceStaleSubscription(registration, subscription, vapidPublicKey);
        return { env: { ...env, registered: true }, deviceId: newId };
      } catch {
        return { env: { ...env, registered: false }, deviceId: null, replaceFailed: true };
      }
    }
    return { env: { ...env, registered: id !== null }, deviceId: id };
  } catch {
    return { env: { ...env, registered: null }, deviceId: null };
  }
}

type Focus = 'test' | 'enable' | 'status';

/**
 * "Notificações": this device's permission and subscription, and the devices that get alerts. The
 * permission prompt only ever comes from the enable button. The server list is the truth: when
 * saving a new subscription fails, the browser subscription is dropped again.
 */
export function PushSettings({
  devices,
  vapidPublicKey,
  product,
  now,
}: {
  devices: PushDeviceDto[] | null;
  vapidPublicKey: string | null;
  product: string;
  /** Server time (ISO), so "há 2 h" is the same on the server render and the client. */
  now: string;
}) {
  const t = useTranslations('preferences.push');
  const common = useTranslations('common');
  const toast = useToast();
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [busy, setBusy] = useState<'enable' | 'disable' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [test, setTest] = useState<'idle' | 'sent' | 'already' | 'error'>('idle');
  const [cooldown, setCooldown] = useState(false);
  const status = useRef<HTMLDivElement>(null);
  const enableButton = useRef<HTMLButtonElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<Focus | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Bumped by "Tentar novamente" to inspect this device again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void inspect(vapidPublicKey).then((result) => {
      if (!cancelled) setInspected(result);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, vapidPublicKey]);
  useEffect(() => () => clearTimeout(cooldownTimer.current), []);

  // Focus follows the state change (the button that was pressed may be gone by now).
  useEffect(() => {
    const target = focusNext.current;
    if (!target || busy) return;
    const element =
      target === 'test'
        ? testButton.current
        : target === 'enable'
          ? enableButton.current
          : status.current;
    if (!element) return;
    focusNext.current = null;
    element.focus();
  });

  const state = derivePushState(inspected?.env ?? null);
  const thisDeviceId = inspected?.deviceId ?? null;

  const enable = useCallback(async () => {
    if (!inspected) return;
    setBusy('enable');
    setError(null);
    setNote(null);
    if (inspected.replaceFailed) setInspected({ ...inspected, replaceFailed: false });
    let subscription: PushSubscription | null = null;
    try {
      if (!vapidPublicKey) throw new Error('no public key');
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        focusNext.current = 'status';
        setInspected({ ...inspected, env: { ...inspected.env, permission: 'denied' } });
        return;
      }
      if (permission !== 'granted') {
        setNote(t('dismissed'));
        return;
      }
      const registration = await readyRegistration();
      const existing = await registration.pushManager.getSubscription();
      if (
        existing &&
        !sameApplicationServerKey(existing.options?.applicationServerKey, vapidPublicKey)
      ) {
        // Subscribing with a new key while an old one exists throws InvalidStateError.
        const id = await replaceStaleSubscription(registration, existing, vapidPublicKey);
        focusNext.current = 'test';
        setInspected({
          env: { ...inspected.env, permission: 'granted', registered: true },
          deviceId: id,
        });
        toast.success(t('enabled'));
        return;
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidPublicKey),
      });
      const keys = subscription.toJSON().keys;
      const saved = await subscribePushAction({
        endpoint: subscription.endpoint,
        keys,
        userAgent: navigator.userAgent,
      });
      if (!saved.ok) throw new Error('not saved');
      subscription = null;
      focusNext.current = 'test';
      setInspected({
        env: { ...inspected.env, permission: 'granted', registered: true },
        deviceId: saved.data.id,
      });
      toast.success(t('enabled'));
    } catch {
      // The browser subscribed but the server did not keep it: no orphan stays behind.
      await subscription?.unsubscribe().catch(() => false);
      // The permission may have been granted on the way: say so, rather than "not asked yet".
      setInspected((current) =>
        current
          ? { ...current, env: { ...current.env, permission: Notification.permission } }
          : current,
      );
      setError(t('enableError'));
    } finally {
      setBusy(null);
    }
  }, [inspected, t, toast, vapidPublicKey]);

  /**
   * Turns this device off: the server row first. A server failure leaves both sides as they were;
   * once the row is gone, a browser that will not drop its subscription is not an error (the
   * server no longer sends to it, and the next enable reuses or replaces the subscription).
   */
  const disable = useCallback(
    async (via: 'button' | 'list'): Promise<boolean> => {
      if (!inspected) return false;
      setBusy('disable');
      setError(null);
      try {
        const subscription = await (await readyRegistration()).pushManager.getSubscription();
        const target = subscription
          ? { endpoint: subscription.endpoint }
          : thisDeviceId
            ? { id: thisDeviceId }
            : null;
        if (target) {
          const removed = await unsubscribePushAction(target);
          if (!removed.ok) throw new Error('not removed');
        }
        try {
          await subscription?.unsubscribe();
        } catch (error) {
          console.error(
            `browser push unsubscribe failed: ${error instanceof Error ? error.name : 'unknown error'}`,
          );
        }
        if (via === 'button') focusNext.current = 'enable';
        setInspected({ env: { ...inspected.env, registered: false }, deviceId: null });
        setTest('idle');
        toast.success(t(via === 'button' ? 'disabled' : 'removed'));
        return true;
      } catch {
        if (via === 'button') setError(t('disableError'));
        else toast.error(t('removeError'));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [inspected, t, thisDeviceId, toast],
  );

  const removeOther = useCallback(
    async (id: string): Promise<boolean> => {
      const removed = await unsubscribePushAction({ id });
      if (!removed.ok) return false;
      toast.success(t('removed'));
      return true;
    },
    [t, toast],
  );

  const sendTest = useCallback(async () => {
    setBusy('test');
    setTest('idle');
    const sent = await sendTestPushAction();
    setBusy(null);
    if (!sent.ok) {
      setTest('error');
      return;
    }
    setTest(sent.data.created ? 'sent' : 'already');
    setCooldown(true);
    clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => setCooldown(false), TEST_COOLDOWN_MS);
  }, []);

  let body: ReactNode;
  let actions: ReactNode = null;
  if (state === 'checking') {
    body = (
      <>
        <span className="sr-only">{t('checking')}</span>
        <Skeleton className="h-11 w-full max-w-sm" />
      </>
    );
  } else if (state === 'unsupported') {
    body = (
      <StatusLine icon={<BellOff className="text-muted-foreground" />}>
        {t('unsupported')}
      </StatusLine>
    );
  } else if (state === 'ios-install') {
    body = (
      <div className="grid grid-cols-1 max-w-[68ch] gap-3 rounded-md bg-surface-2 p-4">
        <p className="flex items-center gap-2 font-semibold">
          <Info className="size-5 shrink-0 text-transfer" aria-hidden="true" />
          {t('iosTitle')}
        </p>
        <ol className="grid grid-cols-1 list-decimal gap-1.5 pl-6 text-sm">
          {(['iosStep1', 'iosStep2', 'iosStep3'] as const).map((key) => (
            <li key={key}>{t.rich(key, { b: (chunks) => <strong>{chunks}</strong>, product })}</li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">{t('iosVersion')}</p>
      </div>
    );
  } else if (state === 'check-failed') {
    body = <StatusLine icon={<XCircle className="text-warning" />}>{t('checkFailed')}</StatusLine>;
    actions = (
      <Button
        variant="secondary"
        className="w-full sm:w-auto"
        onClick={() => {
          setInspected(null);
          setAttempt((n) => n + 1);
        }}
      >
        {common('retry')}
      </Button>
    );
  } else if (state === 'default' || state === 'granted-unsubscribed') {
    body = (
      <StatusLine icon={<BellRing className="text-muted-foreground" />}>
        {t(state === 'default' ? 'notEnabled' : 'grantedNotRegistered')}
      </StatusLine>
    );
    actions = (
      <Button
        ref={enableButton}
        className="w-full sm:w-auto"
        loading={busy === 'enable'}
        disabled={busy !== null && busy !== 'enable'}
        onClick={() => void enable()}
      >
        {busy === 'enable' ? t('enabling') : t(state === 'default' ? 'enable' : 'enableHere')}
      </Button>
    );
  } else if (state === 'denied') {
    const how = inspected?.env.ios
      ? t('deniedIos', { product })
      : /Android/.test(navigator.userAgent)
        ? t('deniedAndroid')
        : t('deniedDesktop');
    body = (
      <div className="grid grid-cols-1 max-w-[68ch] gap-1">
        <StatusLine icon={<XCircle className="text-negative" />}>{t('denied')}</StatusLine>
        <p className="pl-8 text-sm text-muted-foreground">{how}</p>
      </div>
    );
    actions = (
      <Button variant="secondary" className="w-full sm:w-auto" onClick={() => location.reload()}>
        {t('reload')}
      </Button>
    );
  } else {
    body = <StatusLine icon={<CheckCircle2 className="text-positive" />}>{t('on')}</StatusLine>;
    actions = (
      <>
        <Button
          ref={testButton}
          variant="secondary"
          className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:w-auto"
          loading={busy === 'test'}
          disabled={busy !== null && busy !== 'test'}
          // Not `disabled`: a disabled button drops keyboard focus when the cooldown starts.
          aria-disabled={cooldown || undefined}
          aria-describedby={cooldown ? 'push-test-wait' : undefined}
          onClick={() => {
            if (!cooldown) void sendTest();
          }}
        >
          {busy === 'test' ? t('testing') : t('test')}
        </Button>
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          loading={busy === 'disable'}
          disabled={busy !== null && busy !== 'disable'}
          onClick={() => void disable('button')}
        >
          {busy === 'disable' ? t('disabling') : t('disable')}
        </Button>
      </>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3">
        <div
          ref={status}
          role="status"
          tabIndex={-1}
          data-testid="push-status"
          data-state={state}
          className="outline-none"
        >
          {body}
        </div>
        {actions ? <div className="flex flex-col gap-2 sm:flex-row">{actions}</div> : null}
        {note ? (
          <p role="status" className="text-sm text-muted-foreground">
            {note}
          </p>
        ) : null}
        {error || inspected?.replaceFailed ? (
          <Alert tone="error">{error ?? t('enableError')}</Alert>
        ) : null}
        {state === 'subscribed' ? (
          <div className="grid grid-cols-1 gap-1">
            <p role="status" className="text-sm text-muted-foreground">
              {test === 'sent' ? t(cooldown ? 'testSent' : 'testMissing') : null}
              {test === 'already' ? t('testAlready') : null}
            </p>
            {cooldown ? (
              <p id="push-test-wait" className="text-sm text-muted-foreground">
                {t('testWait')}
              </p>
            ) : null}
            {test === 'error' ? <Alert tone="error">{t('testError')}</Alert> : null}
          </div>
        ) : null}
      </div>
      <PushDeviceList
        devices={devices}
        thisDeviceId={thisDeviceId}
        now={now}
        onRemoveThisDevice={() => disable('list')}
        onRemoveOther={removeOther}
      />
    </div>
  );
}

function StatusLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-3 text-base">
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center [&>svg]:size-5"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span>{children}</span>
    </p>
  );
}
