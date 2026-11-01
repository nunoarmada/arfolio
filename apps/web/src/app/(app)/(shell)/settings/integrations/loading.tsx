import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';

/** Heading, the guide card and a few list rows; appears only after 200ms. */
export default async function Loading() {
  const t = await getTranslations('common');
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-1 gap-6 md:gap-8">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-14 w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-3">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
      <div className="grid grid-cols-1 gap-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}
