import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of the month view: header and tabs, four KPI tiles, then the lines beside the aside. */
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
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-32 w-full rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12 xl:gap-6" aria-hidden="true">
        <div className="grid grid-cols-1 gap-6 xl:col-span-8">
          {[0, 1].map((s) => (
            <div key={s} className="grid grid-cols-1 gap-2">
              <Skeleton className="h-6 w-32" />
              <div className="divide-y divide-border rounded-lg bg-surface shadow-card">
                {[0, 1, 2, 3].map((r) => (
                  <div
                    key={r}
                    className="grid min-h-[76px] grid-cols-1 content-center gap-2 px-4 py-3"
                  >
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-2 w-full rounded-full" />
                    <Skeleton className="h-3.5 w-1/3" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden grid-cols-1 gap-6 xl:col-span-4 xl:grid">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
