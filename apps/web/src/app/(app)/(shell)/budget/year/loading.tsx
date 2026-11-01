import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of the year grid: header and tabs, the toolbar, then a table of rows. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4">
      <span className="sr-only">{t('loading')}</span>
      <div className="grid grid-cols-1 gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="flex flex-wrap items-center gap-3" aria-hidden="true">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-10 w-60" />
      </div>
      <div className="divide-y divide-border rounded-lg bg-surface shadow-card" aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="flex h-[52px] items-center gap-4 px-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
