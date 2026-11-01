import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, IconTile } from '@/components/ui/card';
import { cn } from '@/lib/cn';

/**
 * One settings section: a card with its title (and an optional description and action) inside.
 * `flush` lets a divided list run edge to edge under the header; otherwise the body is padded.
 * The title is the section's accessible name, so a page can have several without ambiguity.
 */
export function SettingsCard({
  title,
  titleId,
  description,
  icon,
  actions,
  flush = false,
  id,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  titleId: string;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  flush?: boolean;
  id?: string;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  return (
    <Card
      as="section"
      id={id}
      aria-labelledby={titleId}
      pad="none"
      className={cn('scroll-mt-20', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4 pb-0 md:p-5 md:pb-0 xl:p-6 xl:pb-0">
        <div className="flex min-w-0 flex-1 basis-48 items-start gap-2.5">
          {icon ? <IconTile icon={icon} /> : null}
          <div className="min-w-0">
            <h2 id={titleId} className="text-card-title">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 max-w-[68ch] text-label font-normal text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions}
      </header>
      <div
        className={cn(
          flush ? 'mt-4 border-t border-border' : 'grid grid-cols-1 gap-4 p-4 md:p-5 xl:p-6',
          !flush && 'pt-4 md:pt-4 xl:pt-4',
          bodyClassName,
        )}
      >
        {children}
      </div>
    </Card>
  );
}
