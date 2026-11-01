'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Edges {
  /** Scrolled all the way back (or nothing to scroll): no shadow on the leading edge. */
  start: boolean;
  /** Scrolled all the way along (or nothing to scroll): no shadow on the trailing edge. */
  end: boolean;
}

/**
 * Tracks whether a horizontally scrolling element has more to show on either side, so the
 * wrapper can draw edge shadows. Returns a callback ref for the scroller and the two flags.
 * Both start as `true` (no shadows) so the server render and the first paint stay clean.
 */
export function useScrollEdges(): Edges & { ref: (node: HTMLElement | null) => void } {
  const [edges, setEdges] = useState<Edges>({ start: true, end: true });
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;
    const measure = () => {
      const max = node.scrollWidth - node.clientWidth;
      // RTL scrolls with a negative scrollLeft, so compare on the absolute value.
      const at = Math.abs(node.scrollLeft);
      const next = { start: at <= 1, end: max - at <= 1 };
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The content (a table) can grow without the scroller resizing.
    for (const child of Array.from(node.children)) observer.observe(child);
    cleanup.current = () => {
      node.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      cleanup.current?.();
    },
    [],
  );

  return { ...edges, ref };
}

type Label = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

/**
 * A horizontally scrolling area that says so: a named, focusable region (so keyboard users can
 * scroll it) with 16px edge shadows that appear on the side that has more. The focus ring is
 * drawn inset because the scroller clips its own outline. Put a table, or any wide row, inside;
 * a first column that should stay put takes `dataTable.stickyFirst`.
 */
export function ScrollRegion({
  label,
  labelledBy,
  className,
  scrollerClassName,
  testId,
  children,
}: Label & {
  className?: string;
  scrollerClassName?: string;
  /** `data-testid` of the outer wrapper (the scroller and its shadows). */
  testId?: string;
  children: ReactNode;
}) {
  const { ref, start, end } = useScrollEdges();
  return (
    <div
      data-testid={testId}
      data-start={start}
      data-end={end}
      className={cn(
        'group/scroll relative min-w-0 overflow-hidden rounded-lg bg-surface shadow-card',
        // 16px gradient shadows on the two edges, shown only while there is more that way.
        'before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-20 before:w-4 before:bg-gradient-to-r before:from-[var(--edge-shadow)] before:to-transparent before:opacity-0 before:transition-opacity before:duration-[120ms]',
        'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:z-20 after:w-4 after:bg-gradient-to-l after:from-[var(--edge-shadow)] after:to-transparent after:opacity-0 after:transition-opacity after:duration-[120ms]',
        'data-[start=false]:before:opacity-100 data-[end=false]:after:opacity-100',
        className,
      )}
    >
      <div
        ref={ref}
        role="region"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={0}
        className={cn(
          'overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          scrollerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
