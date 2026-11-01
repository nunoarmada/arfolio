import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type PageWidth = 'full' | 'wide' | 'narrow';

const WIDTHS: Record<PageWidth, string> = {
  /** Data-dense pages (transactions, the year grid, import): the whole content area. */
  full: 'w-full',
  /** Dashboards and lists: capped so a 4K monitor does not stretch a row across the screen. */
  wide: 'mx-auto w-full max-w-[1480px]',
  /** Forms, settings detail, wizards: a comfortable single column. */
  narrow: 'w-full max-w-[760px]',
};

/**
 * Sets how wide a page may grow. The shell's `main` has no cap of its own, each page picks one
 * here, so a list page never stops at an inner 640 or 720px.
 */
export function PageContainer({
  width = 'wide',
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn(WIDTHS[width], className)}>{children}</div>;
}
