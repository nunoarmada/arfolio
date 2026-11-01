import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * One <h1> per page. The title (two lines at most on phones, one from md up, the full text in
 * `title`) sits left with an optional description; `actions` sit right and wrap below the title
 * when they no longer fit. `tabs` takes a `PageTabs` nav (the sections of an area), drawn under
 * the heading with a hairline. The phone back chevron shows on detail pages only.
 */
export function PageHeader({
  title,
  backHref,
  backLabel,
  actions,
  description,
  tabs,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  description?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <header className="mb-5 md:mb-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-1">
          {backHref ? (
            <Link
              href={backHref}
              aria-label={backLabel}
              className="-ml-3 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2 md:hidden"
            >
              <ChevronLeft className="size-6" aria-hidden="true" />
            </Link>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1
              title={title}
              className="text-title min-w-0 break-words max-md:line-clamp-2 md:truncate"
            >
              {title}
            </h1>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? <div className="mt-4">{tabs}</div> : null}
    </header>
  );
}
