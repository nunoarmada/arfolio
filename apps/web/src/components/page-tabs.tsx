'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface PageTab {
  href: string;
  label: string;
  active: boolean;
}

/**
 * Underline tabs for the sections of one area (Mês · Ano · …). They are links to pages of
 * their own, so this is a `<nav>` with `aria-current`, not a tab list. The row scrolls
 * sideways when it does not fit and fades at an edge that has more behind it.
 */
export function PageTabs({ items, label }: { items: PageTab[]; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const start = node.scrollLeft > 1;
    const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const active = node.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      node.scrollLeft = Math.max(
        0,
        active.offsetLeft - (node.clientWidth - active.offsetWidth) / 2,
      );
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [measure]);

  return (
    <nav aria-label={label}>
      <div
        ref={scroller}
        onScroll={measure}
        style={
          {
            '--fade-start': edges.start ? '28px' : '0px',
            '--fade-end': edges.end ? '28px' : '0px',
          } as React.CSSProperties
        }
        className="-mx-1 overflow-x-auto px-1 shadow-[inset_0_-1px_0_var(--border)] [mask-image:linear-gradient(to_right,transparent,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul className="flex w-max min-w-full gap-1 whitespace-nowrap">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'relative flex h-11 items-center rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:[outline-offset:-2px] md:h-10',
                  item.active
                    ? 'text-primary-text after:bg-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
