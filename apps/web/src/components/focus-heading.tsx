'use client';

import { useEffect } from 'react';

/**
 * Moves focus to the page's <h1> on arrival. After a cross-site redirect (the bank) nothing has
 * focus, and the heading is the first thing a screen reader should read.
 */
export function FocusHeading() {
  useEffect(() => {
    const h1 = document.querySelector<HTMLElement>('main h1');
    if (!h1) return;
    h1.tabIndex = -1;
    h1.classList.add('outline-none');
    h1.focus({ preventScroll: true });
  }, []);
  return null;
}
