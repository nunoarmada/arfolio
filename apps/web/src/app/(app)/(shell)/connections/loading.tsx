import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-52" />
      {[0, 1].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="grid grid-cols-1 gap-4 rounded-lg bg-surface shadow-card p-4 md:p-5"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-5 w-40" />
          </div>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-11 w-full md:w-40" />
        </div>
      ))}
    </div>
  );
}
