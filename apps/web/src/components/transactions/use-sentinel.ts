'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `onVisible` whenever the returned element scrolls near the viewport and `enabled` is
 * true (infinite scroll). A visible "load more" button stays next to it as the keyboard path.
 */
export function useSentinel<T extends HTMLElement>(enabled: boolean, onVisible: () => void) {
  const ref = useRef<T>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callback.current();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);
  return ref;
}
