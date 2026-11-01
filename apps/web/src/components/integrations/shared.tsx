'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';

/** Geist has no mono face: tabular figures and a slashed zero keep tokens unambiguous. */
export const IDENT = 'tabular-nums [font-feature-settings:"zero"_1]';

/** Section heading (focus target when a list empties) with its help line and optional action. */
export function SectionHeader({
  id,
  title,
  help,
  action,
}: {
  id: string;
  title: string;
  help: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:flex sm:items-start sm:justify-between sm:gap-4">
      <div className="grid grid-cols-1 min-w-0 gap-1">
        <h2 id={id} tabIndex={-1} className="text-heading outline-none">
          {title}
        </h2>
        <p className="max-w-[68ch] text-sm text-muted-foreground">{help}</p>
      </div>
      {action}
    </div>
  );
}

/** A section that could not load: what failed and a retry, with its heading kept. */
export function LoadError({
  id,
  title,
  help,
  message,
}: {
  id: string;
  title: string;
  help: string;
  message: string;
}) {
  const router = useRouter();
  const common = useTranslations('common');
  return (
    <section aria-labelledby={id} className="grid grid-cols-1 gap-3">
      <SectionHeader id={id} title={title} help={help} />
      <Alert
        tone="error"
        action={
          <Button variant="link" onClick={() => router.refresh()}>
            {common('retry')}
          </Button>
        }
      >
        {message}
      </Alert>
    </section>
  );
}

/** One collapsible list row: `grid-template-rows` 1fr to 0fr, instant with reduced motion. */
export function CollapsibleRow({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <li
      inert={collapsed}
      className={cn(
        'grid grid-cols-1 transition-[grid-template-rows] duration-[180ms] ease-out motion-reduce:transition-none',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </li>
  );
}

/** The empty state of a list: a compact card under the section header, with no heading of its own. */
export function EmptyCard({
  icon,
  children,
  action,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg bg-surface shadow-card p-4 md:p-5">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&>svg]:size-5"
      >
        {icon}
      </span>
      <p className="max-w-[52ch] text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}
