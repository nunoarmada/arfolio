import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/**
 * A home block that could not load, in the frame of the block itself (card, title and "Ver tudo"
 * kept, same height as its skeleton) so the grid does not jump: an icon, one sentence and a retry,
 * which is a plain link to the same page.
 */
export function BlockError({
  titleId,
  title,
  message,
  retry,
  link,
  className,
}: {
  titleId: string;
  title: string;
  message: string;
  retry: string;
  /** The block's usual header link, kept so the way to the full page survives the failure. */
  link?: { href: string; label: string };
  className?: string;
}) {
  return (
    <Card as="section" aria-labelledby={titleId} className={cn('flex flex-col', className)}>
      <CardHeader title={title} titleId={titleId} link={link} />
      <div className="flex flex-1 flex-col items-start justify-center gap-3">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <AlertCircle
            className="mt-0.5 size-4 shrink-0 text-subtle-foreground"
            aria-hidden="true"
          />
          <span>{message}</span>
        </p>
        <a href="/" className={buttonVariants({ variant: 'outline' })}>
          {retry}
        </a>
      </div>
    </Card>
  );
}

/**
 * A block's placeholder at its final geometry. The first one on the page announces the loading
 * (`status`); the rest stay silent so a screen reader hears it once.
 */
export function BlockSkeleton({ className, status }: { className: string; status?: ReactNode }) {
  if (status) {
    return (
      <div role="status" aria-busy="true" className="h-full">
        <span className="sr-only">{status}</span>
        <Skeleton className={cn('w-full rounded-lg', className)} />
      </div>
    );
  }
  return <Skeleton className={cn('w-full rounded-lg', className)} />;
}

/** A KPI tile's placeholder: the same height as the real tile, so the strip does not jump. */
export function KpiSkeleton({ status }: { status?: ReactNode }) {
  const tile = <Skeleton className="h-[148px] w-full rounded-lg md:h-[156px] xl:h-[164px]" />;
  if (status) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">{status}</span>
        {tile}
      </div>
    );
  }
  return tile;
}
