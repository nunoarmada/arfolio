import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

/**
 * One sentence on why it is empty plus, where there is one, a primary action. An empty screen is
 * an invitation: a 40px soft-brand icon tile, a 16/600 title, a body of at most 52 characters per
 * line and the call to action.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  headingId,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Gives the heading an id and makes it focusable (to move focus here when the list empties). */
  headingId?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg bg-surface p-5 shadow-card md:p-6',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&>svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <h2
        id={headingId}
        tabIndex={headingId ? -1 : undefined}
        className="text-base font-semibold outline-none"
      >
        {title}
      </h2>
      {children ? <p className="max-w-[52ch] text-sm text-muted-foreground">{children}</p> : null}
      {action}
    </section>
  );
}
