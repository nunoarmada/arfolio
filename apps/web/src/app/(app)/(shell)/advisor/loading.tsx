import { getTranslations } from 'next-intl/server';
import { PageContainer } from '@/components/page-container';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Title, three bubbles (left, right, left) and the composer bar, at the page's own geometry. */
export default async function AdvisorLoading() {
  const common = await getTranslations('common');
  return (
    <PageContainer width="narrow">
      <div role="status" aria-busy="true">
        <span className="sr-only">{common('loading')}</span>
        <Skeleton className="mb-5 h-8 w-56 md:mb-6" />
        <Card
          pad="none"
          className="flex h-[calc(100dvh-14rem-env(safe-area-inset-bottom))] min-h-[420px] flex-col overflow-hidden md:h-[calc(100dvh-8.5rem)]"
        >
          <div className="flex flex-1 flex-col gap-3 p-4">
            <Skeleton className="h-16 w-3/4 rounded-xl" />
            <Skeleton className="ml-auto h-10 w-1/2 rounded-xl" />
            <Skeleton className="h-20 w-4/5 rounded-xl" />
          </div>
          <div className="border-t p-3">
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        </Card>
      </div>
    </PageContainer>
  );
}
