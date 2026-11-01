import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <div
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-28 rounded-lg" />
        ))}
      </div>
      {[0, 1].map((g) => (
        <div key={g} className="grid grid-cols-1 gap-2" aria-hidden="true">
          <Skeleton className="h-6 w-40" />
          <div className="divide-y divide-border rounded-lg bg-surface shadow-card">
            {[0, 1, 2].map((r) => (
              <div key={r} className="flex min-h-16 items-center gap-3 px-4 py-2">
                <Skeleton className="size-10 rounded-full" />
                <div className="grid grid-cols-1 flex-1 gap-1.5">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3.5 w-1/4" />
                </div>
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
