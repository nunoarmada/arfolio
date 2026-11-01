'use client';

import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Card, IconTile } from '../ui/card';

/**
 * The "Vendido a …" / "Liquidado a …" block at the top of a record's page. Its heading takes
 * focus (tabIndex -1) after an action that changes the page into this state.
 */
export function StatusBlock({
  icon: Icon,
  heading,
  headingRef,
  children,
}: {
  icon: LucideIcon;
  heading: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card as="section" aria-labelledby={id} data-testid="status-block" className="grid grid-cols-1">
      <div className="flex items-start gap-3">
        <IconTile icon={Icon} tone="neutral" />
        <div className="grid min-w-0 grid-cols-1 gap-1.5">
          <h2
            id={id}
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
          >
            {heading}
          </h2>
          {children}
        </div>
      </div>
    </Card>
  );
}

/**
 * Where focus goes once the page has re-rendered in its new state: the trigger that was used no
 * longer exists, so the caller says `status` (the new status heading) or `title` (the page h1)
 * right after the action succeeded, and the move happens when `stateKey` changes.
 */
export function useFocusAfterChange(stateKey: string) {
  const target = useRef<'status' | 'title' | null>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (target.current === 'status') statusRef.current?.focus();
    if (target.current === 'title') {
      const title = document.querySelector('h1');
      title?.setAttribute('tabindex', '-1');
      title?.focus();
    }
    target.current = null;
  }, [stateKey]);
  return {
    statusRef,
    focusStatusNext: () => {
      target.current = 'status';
    },
    focusTitleNext: () => {
      target.current = 'title';
    },
  };
}
