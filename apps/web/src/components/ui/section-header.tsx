import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The heading between cards (a card has its own `CardHeader`): `heading` type, an optional count
 * chip, a muted tabular aggregate and an action on the right.
 */
export function SectionHeader({
  title,
  id,
  count,
  aggregate,
  action,
  level = 2,
  className,
}: {
  title: ReactNode;
  id?: string;
  count?: number;
  aggregate?: ReactNode;
  action?: ReactNode;
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-1', className)}>
      <div className="flex min-w-0 items-center gap-2">
        <Heading id={id} className="text-heading">
          {title}
        </Heading>
        {count !== undefined ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-3 px-1.5 text-caption font-semibold tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
        {aggregate ? (
          <span className="text-sm tabular-nums text-muted-foreground">{aggregate}</span>
        ) : null}
      </div>
      {action}
    </div>
  );
}
