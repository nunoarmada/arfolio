import { getTranslations } from 'next-intl/server';
import { ListSkeleton } from '@/components/transactions/transactions-view';
import { Skeleton } from '@/components/ui/skeleton';

/** Three day headers of four rows each, the shape of the final list; shown after 200ms. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-full md:w-80" />
      <ListSkeleton />
    </div>
  );
}
