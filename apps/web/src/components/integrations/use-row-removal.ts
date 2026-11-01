'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const COLLAPSE_MS = 180;

/**
 * What a list does when one of its rows is revoked: the row collapses (instantly with reduced
 * motion), then the page refreshes and drops it, and focus moves to the next row's action button
 * (or to the section heading when the list empties). Rows read `collapsing` for their state and
 * register their action button with `buttonRef`.
 */
export function useRowRemoval(ids: string[], headingId: string, blocked: boolean) {
  const router = useRouter();
  const [collapsing, setCollapsing] = useState<ReadonlySet<string>>(new Set());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const opener = useRef<HTMLElement | null>(null);
  // Where focus goes once the removed row has left the list.
  const focusAfter = useRef<{ index: number; before: string } | null>(null);
  const key = ids.join(',');

  useEffect(() => {
    const target = focusAfter.current;
    // Wait until the list has really dropped the row and the dialog (which traps focus) is gone.
    if (!target || blocked || key === target.before) return;
    if (ids.length === 0) document.getElementById(headingId)?.focus();
    else buttons.current.get(ids[Math.min(target.index, ids.length - 1)]!)?.focus();
    focusAfter.current = null;
  }, [key, blocked, ids, headingId]);

  /** Starts the collapse of row `id`; call it once the server has confirmed the revocation. */
  const collapse = useCallback(
    (id: string) => {
      focusAfter.current = { index: ids.indexOf(id), before: key };
      setCollapsing((current) => new Set(current).add(id));
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.setTimeout(() => router.refresh(), reduced ? 0 : COLLAPSE_MS);
    },
    [ids, key, router],
  );

  const buttonRef = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) buttons.current.set(id, el);
      else buttons.current.delete(id);
    },
    [],
  );

  /** For a dialog's onCloseAutoFocus: focus is placed by hand, never left to Radix. */
  const onDialogClosed = useCallback((event: Event) => {
    event.preventDefault();
    if (!focusAfter.current) opener.current?.focus();
  }, []);

  return { collapsing, collapse, buttonRef, opener, onDialogClosed };
}
