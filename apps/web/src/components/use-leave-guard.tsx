'use client';

import { AlertDialog } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from './ui/button';

/**
 * Leaving a form with unsaved edits asks first. Closing the tab or reloading uses the browser's
 * own prompt; clicking a link inside the app opens a dialog (the App Router has no hook for
 * that). Call `leave(href)` for buttons that navigate by themselves.
 */
export function useLeaveGuard(dirty: boolean): {
  dialog: ReactNode;
  leave: (href: string) => void;
} {
  const t = useTranslations('leaveGuard');
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const anchor = (e.target as Element | null)?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      e.preventDefault();
      e.stopPropagation();
      setTarget(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const leave = useCallback(
    (href: string) => {
      if (dirty) setTarget(href);
      else router.push(href);
    },
    [dirty, router],
  );

  const dialog = (
    <AlertDialog.Root
      open={target !== null}
      onOpenChange={(open) => (open ? undefined : setTarget(null))}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <AlertDialog.Title className="text-lg font-semibold">{t('title')}</AlertDialog.Title>
          <AlertDialog.Description className="text-base text-muted-foreground">
            {t('body')}
          </AlertDialog.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="outline">{t('stay')}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="destructive"
                onClick={() => {
                  const href = target;
                  setTarget(null);
                  if (href) router.push(href);
                }}
              >
                {t('discard')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );

  return { dialog, leave };
}
