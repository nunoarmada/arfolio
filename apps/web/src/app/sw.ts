/// <reference lib="webworker" />
import { NetworkOnly, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from 'serwist';
import { findSameOriginClient, parsePushPayload, safeNotificationUrl } from '../lib/sw-helpers';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

/** Precached at install (see next.config.ts); the only page the worker ever stores. */
const OFFLINE_URL = '/offline';

// Only the hashed build assets and the static /offline page are precached. Pages, RSC payloads and
// API responses carry private household data and are never stored by the worker: navigations go
// straight to the network, and only a network-level failure (the fetch rejects) is answered with
// the precached /offline page. A non-2xx response from the server is passed through untouched.
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      matcher: ({ request }) => request.mode === 'navigate',
      // A dead-slow network ends in a network error after 15 s, which triggers the fallback.
      handler: new NetworkOnly({ networkTimeoutSeconds: 15 }),
    },
  ],
  fallbacks: {
    entries: [{ url: OFFLINE_URL, matcher: ({ request }) => request.mode === 'navigate' }],
  },
});
serwist.addEventListeners();

// Lock-screen text only (no amounts or names): see packages/services/src/push-copy.ts.
self.addEventListener('push', (event) => {
  const { title, body, tag, url } = parsePushPayload(event.data?.text());
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/192',
      badge: '/icons/badge',
      tag,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const raw =
    typeof data === 'object' && data !== null ? (data as { url?: unknown }).url : undefined;
  event.waitUntil(openOrFocus(safeNotificationUrl(raw, self.location.origin)));
});

/** `target` is already an absolute, origin-checked URL: never resolve it again. */
async function openOrFocus(target: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = findSameOriginClient(windows, self.location.origin);
  if (existing) {
    // navigate() resolves to null for a client the worker does not control and may reject: then
    // fall back to a new window so the click is never silently lost.
    try {
      const navigated = (await existing.navigate(target)) ?? existing;
      await navigated.focus();
      return;
    } catch {
      // fall through
    }
  }
  await self.clients.openWindow(target);
}
