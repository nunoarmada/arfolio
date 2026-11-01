import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of the line editor: title, four fields, a grid of twelve amounts. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid max-w-[760px] grid-cols-1 gap-5">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-48" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid grid-cols-1 gap-1.5" aria-hidden="true">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
