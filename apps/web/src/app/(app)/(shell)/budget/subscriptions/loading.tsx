import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4 xl:gap-6">
      <span className="sr-only">{t('loading')}</span>
      <div className="grid grid-cols-1 gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div
        aria-hidden="true"
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
      >
        {[0, 1].map((k) => (
          <Skeleton key={k} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <div className="divide-y divide-border rounded-lg bg-surface shadow-card" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid min-h-16 grid-cols-1 content-center gap-1.5 px-4 py-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
