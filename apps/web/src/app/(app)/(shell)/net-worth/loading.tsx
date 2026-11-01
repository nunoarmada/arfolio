import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of Resumo: title, segmented bar, hero, pair card, chart card and two lists. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-48" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" aria-hidden="true">
        <div className="grid grid-cols-1 content-start gap-3 lg:col-span-4">
          <Skeleton className="h-12 w-56" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
        <Skeleton className="h-[200px] w-full rounded-lg md:h-[260px] lg:col-span-8 lg:h-[320px]" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" aria-hidden="true">
        {[0, 1].map((s) => (
          <div key={s} className="grid grid-cols-1 content-start gap-2">
            <Skeleton className="h-6 w-32" />
            <div className="divide-y rounded-lg bg-surface shadow-card">
              {[0, 1, 2].map((r) => (
                <div key={r} className="grid grid-cols-1 min-h-16 content-center gap-2 px-4 py-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3.5 w-1/3" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
