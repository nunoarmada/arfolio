'use client';

import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { releasePushSubscription } from '@/lib/push-signout';
import { unsubscribePushAction } from '@/server/actions/push';

/** This browser's push subscription. `getRegistration` (unlike `ready`) settles when there is no worker. */
async function currentPushSubscription() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager?.getSubscription()) ?? null;
}

export function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    try {
      // Needs the session, so before it ends. Bounded and never throws: sign-out must not wait on push.
      await releasePushSubscription({
        getSubscription: currentPushSubscription,
        releaseOnServer: (endpoint) => unsubscribePushAction({ endpoint }),
      });
      await authClient.signOut();
    } finally {
      // Whatever happened, leave the app: the sign-in page decides what the session is worth.
      router.replace('/sign-in');
      router.refresh();
    }
  }
  return { signOut, pending };
}

export function SignOutButton({
  variant = 'outline',
  className,
}: Pick<ButtonProps, 'variant' | 'className'>) {
  const t = useTranslations('shell');
  const { signOut, pending } = useSignOut();
  return (
    <Button
      variant={variant}
      className={className}
      loading={pending}
      onClick={() => void signOut()}
    >
      {!pending ? <LogOut className="size-4" aria-hidden="true" /> : null}
      {pending ? t('signingOut') : t('signOut')}
    </Button>
  );
}
