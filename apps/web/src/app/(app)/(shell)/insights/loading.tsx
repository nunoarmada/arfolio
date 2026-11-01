import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** The shape of Análises: title, the two controls, spending and cash flow side by side, trends. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-56" />
      <div className="flex flex-wrap items-center justify-between gap-3" aria-hidden="true">
        <Skeleton className="h-11 w-56" />
        <Skeleton className="h-11 w-48" />
      </div>
      <div
        className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12 lg:gap-8"
        aria-hidden="true"
      >
        <Skeleton className="h-[400px] w-full rounded-lg lg:col-span-7" />
        <Skeleton className="h-[220px] w-full rounded-lg lg:col-span-5" />
        <Skeleton className="h-[360px] w-full rounded-lg lg:col-span-12" />
      </div>
    </div>
  );
}
