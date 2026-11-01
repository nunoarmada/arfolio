import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4 lg:grid-cols-12 xl:gap-6">
      <span className="sr-only">{t('loading')}</span>
      <div className="grid grid-cols-1 gap-3 lg:col-span-12" aria-hidden="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-28 w-full rounded-lg lg:col-span-12" />
      <Skeleton className="h-56 w-full rounded-lg lg:col-span-5" />
      <div
        className="divide-y divide-border rounded-lg bg-surface shadow-card lg:col-span-7"
        aria-hidden="true"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex min-h-16 items-center gap-3 px-4 py-2">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
