import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** Matches the final layout (title row, one card) and appears only after 200ms. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="mb-6 h-8 w-48" />
      <Skeleton className="h-[150px] w-full rounded-lg" />
      <Skeleton className="mt-6 h-40 w-full rounded-lg" />
    </div>
  );
}
