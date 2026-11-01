'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type InsightsView = 'chart' | 'table';

const KEY = 'insights-view';
const EVENT = 'insights-view-change';

/** Used when the browser's storage is unavailable, so the toggle still works for this visit. */
let fallback: InsightsView | null = null;

function read(): InsightsView {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) return stored === 'table' ? 'table' : 'chart';
  } catch {
    // storage unavailable: use the in-memory choice
  }
  return fallback ?? 'chart';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * Chart or table, for all three sections at once. The choice is remembered on this device only
 * (`localStorage`), and the sections stay in step through an event.
 */
export function useInsightsView(): [InsightsView, () => void] {
  const view = useSyncExternalStore(subscribe, read, () => 'chart' as InsightsView);
  const toggle = useCallback(() => {
    const next: InsightsView = read() === 'table' ? 'chart' : 'table';
    fallback = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // not remembered, still works for this visit
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [view, toggle];
}
