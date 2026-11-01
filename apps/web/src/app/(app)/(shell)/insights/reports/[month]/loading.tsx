import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of one report: title, meta line, the AI block, two anomalies and the numbers table. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6">
      <span className="sr-only">{t('loading')}</span>
      <div className="grid grid-cols-1 gap-6 md:gap-8" aria-hidden="true">
        <div className="grid grid-cols-1 gap-3">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="grid grid-cols-1 gap-4 rounded-lg bg-surface shadow-card p-4 md:p-6">
          <Skeleton className="h-7 w-3/4" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
        <Skeleton className="h-[184px] w-full" />
      </div>
    </div>
  );
}
