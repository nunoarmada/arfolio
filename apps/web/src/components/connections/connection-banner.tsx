import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { ToneCard } from '@/components/ui/card';
import { connectionStatus, isBlocking } from '@/lib/connection-status';
import type { ConnectionDto } from '@/server/serialize';

/**
 * The persistent banner for a connection that expired or needs renewal (design system 4.4). One
 * connection names it and offers "Renovar acesso"; several point to the list.
 */
export async function ConnectionBanner({
  connections,
  now,
  timeZone,
}: {
  connections: ConnectionDto[];
  now: Date;
  timeZone: string;
}) {
  const blocked = connections.filter((c) => isBlocking(connectionStatus(c, now, timeZone).key));
  if (blocked.length === 0) return null;
  const t = await getTranslations('connections');
  const only = blocked.length === 1 ? blocked[0]! : null;
  const expired = only ? connectionStatus(only, now, timeZone).key === 'expired' : false;
  return (
    <ToneCard
      tone="negative"
      label={t('strip.title')}
      action={
        <Link
          href={
            only && only.provider === 'enablebanking'
              ? `/connections/new/bank/authorise?connection=${only.id}`
              : '/connections'
          }
          className={buttonVariants({ variant: 'outline' })}
        >
          {only && only.provider === 'enablebanking' ? t('banner.renew') : t('banner.view')}
        </Link>
      }
    >
      {only
        ? t(expired ? 'banner.oneExpired' : 'banner.one', { name: only.displayName })
        : t('banner.many', { count: blocked.length })}
    </ToneCard>
  );
}
