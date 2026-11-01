import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of the reports list: title, the two links, the heading and four rows. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6">
      <span className="sr-only">{t('loading')}</span>
      <div className="grid grid-cols-1 gap-6" aria-hidden="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-11 w-56" />
        <div className="grid grid-cols-1 gap-4">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-1 divide-y overflow-hidden rounded-lg bg-surface shadow-card">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[72px] w-full rounded-none" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
