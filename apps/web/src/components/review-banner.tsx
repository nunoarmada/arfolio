import { ClipboardCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { ToneCard } from '@/components/ui/card';

/** A slim warning card with the count of movements waiting and "Rever"; hidden when nothing waits. */
export async function ReviewBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  const [t, home] = await Promise.all([getTranslations('review'), getTranslations('home')]);
  return (
    <ToneCard
      tone="warning"
      icon={ClipboardCheck}
      label={t('title')}
      action={
        <Link
          href="/transactions/review"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {home('reviewAction')}
        </Link>
      }
    >
      {t('banner', { count })}
    </ToneCard>
  );
}
