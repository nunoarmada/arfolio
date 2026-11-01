import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <div className="divide-y rounded-lg bg-surface shadow-card" aria-hidden="true">
        {[0, 1, 2, 3].map((r) => (
          <div key={r} className="grid grid-cols-1 gap-2 px-4 py-3">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="ml-auto h-11 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
